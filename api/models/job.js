const dblib = require('../db.js');
const Promise = require('bluebird');
const proc = require('child_process');
const pathlib = require('path');
const shortid = require('shortid');
//const requestp = require('request-promise');

const config = require('../../config.json'); // FIXME pass in
const apps = require('../../apps.json'); //config.apps ? require(config.apps) : {}; //FIXME pass in
const systems = require('../../systems.json'); //config.systems ? require(config.systems) : {}; //FIXME pass in

const STATUS = {
    CREATED:         "CREATED",         // Created/queued
    STAGING_INPUTS:  "STAGING_INPUTS",  // Transferring input files from IRODS to HDFS
    RUNNING:         "RUNNING",         // Running on Hadoop
    ARCHIVING:       "ARCHIVING",       // Transferring output files from HDFS to IRODS
    FINISHED:        "FINISHED",        // All steps finished successfully
    FAILED:          "FAILED",          // Non-zero return code from any step
    STOPPED:         "STOPPED"          // Cancelled due to server restart
}

const MAX_JOBS_RUNNING = config.maxNumRunningJobs || 4;

class Job {
    constructor(props) {
        this.id = props.id || 'planb-' + shortid.generate();
        this.username = props.username; // CyVerse username of user running the job
        this.token = props.token;
        this.name = props.name;
        this.appId = props.appId;
        this.startTime = props.startTime;
        this.endTime = props.endTime;
        this.inputs = props.inputs || {};
        this.parameters = props.parameters || {};
        this.status = props.status || STATUS.CREATED;

        this.app = apps[this.appId];
        //if (!this.app) {} //TODO

        let system = systems[this.app.executionSystem];
        //if (!system) {} //TODO
        this.system = new ExecutionSystem(system);

        this.deploymentPath = this.app.deploymentPath;
        this.stagingPath = system.stagingPath + '/' + this.id;
        this.mainLogFile = system.stagingPath + '/jobs.log';
        this.jobLogFile = this.stagingPath + '/data/job.log';

        if (system.type == "hadoop") {
            this.targetPath = system.targetHdfsPath + '/' + this.id;
        }
    }

    setStatus(newStatus) {
        if (this.status == newStatus)
            return;

        this.status = newStatus;

        // TODO
//        this.history.push({
//            created: dblib.getTimestamp(),
//            createdBy: this.username,
//            description: "",
//            status: newStatus
//        });
    }

    async stageInputs() {
        var self = this;
        var dataStagingPath = this.stagingPath + '/data/';
        //var stageScript = config.remoteStagingPath + '/stage_data.sh';

        // Make sure staging area exists
        let rc = await this.system.execute(['mkdir -p', dataStagingPath]);

        // Print IRODS user info for debug
        rc = await this.system.execute(['iuserinfo']);

        // Download app to staging area
        rc = await this.system.execute(['iget -Tr', this.deploymentPath, this.stagingPath]);

        // Share output path with "imicrobe"
        var homePath = '/' + this.username
        rc = await sharePath(self.token, homePath, "READ", false); // Need to share home path for sharing within home path to work
        var archivePath = homePath + '/' + config.archivePath
        rc = await agave_mkdir(self.token, archivePath); // Create archive path in case it doesn't exist yet (new user)
        rc = await sharePath(self.token, archivePath, "READ_WRITE", false);

        // Create log file
        rc = await this.system.execute(['mkdir -p', this.stagingPath, '&& touch', this.jobLogFile]);

        if (this.inputs) {
            let inputs = Object.values(this.inputs).reduce((acc, val) => acc.concat(val), []);

            // First share the input paths with the "imicrobe" user
            for (let path of inputs) {
                if (!path.startsWith('/shared')) // Skip for paths in /iplant/home/shared
                    rc = await sharePath(self.token, path/*pathlib.dirname(path)*/, "READ", true);
            }

            // Transfer input files
            for (let path of inputs) {
                console.log('Job ' + this.id + ': staging input: ' + path);
                  var irodsPath = (path.startsWith('/iplant/home') ? path : '/iplant/home' + path);
                  var targetPath = dataStagingPath + pathlib.basename(path);
                  rc = await this.system.execute(['iget -Tr', irodsPath, targetPath]); // works for file or directory
            }
        }
    }

    async run() {
        var dataStagingPath = this.stagingPath + '/data/';

        let params = [];
        for (let id in this.inputs) {
            let arg = this.app.inputs.filter(inp => inp.id == id)[0].details.argument || "";
            let val = this.inputs[id];
            if (Array.isArray(val)) {
                val = val.map(v => dataStagingPath + pathlib.basename(v));
                val = val.join(' ');
            }
            else if (val != "") {
                val = dataStagingPath + pathlib.basename(val);
            }
            params.push(arg + ' ' + val);
        }

        for (let id in this.parameters) {
            let param = this.app.parameters.filter(param => param.id == id)[0];
            let arg = param.details.argument;
            let val = this.parameters[id];
            if (val == "")
                val = param.value.default;
            if (Array.isArray(val))
                val = val.join(' ');

            if (param.value.type == "flag") {
                if (val === true)
                    params.push(arg);
            }
            else
                params.push(arg + ' "' + val + '"');
        }

        let subdir = this.deploymentPath.match(/([^\/]*)\/*$/)[1]; //*/
        let runScript = this.stagingPath + '/' + subdir + '/run.sh';
        let rc = await this.system.execute(['sh', runScript, params.join(' '), ' 2>&1 | tee -a ', this.mainLogFile, this.jobLogFile]);
    }

    async archive() {
        var self = this;
        var dataStagingPath = this.stagingPath + '/data/';

        var archivePath = '/iplant/home/' + this.username + '/' + config.archivePath + '/' + 'job-' + this.id;
        let rc = await this.system.execute(['iput -Tr', dataStagingPath, archivePath]); // removed "-K checksum" because hanging on node0
        rc = await this.system.execute(['ichmod -r own', this.username, archivePath]);
    }
}

class JobManager {
    constructor(props) {
        this.isMaster = props.isMaster;
        this.UPDATE_INITIAL_DELAY = 5000; // milliseconds
        this.UPDATE_REFRESH_DELAY = 5000; // milliseconds

        this.init();
    }

    async init() {
        var self = this;

        console.log("JobManager.init");

        this.db = new dblib.Database();
        await this.db.open(config.dbFilePath);

        // Set pending jobs to cancelled
        if (this.isMaster) {
            console.log("Setting all jobs to STOPPED");
            await this.db.stopJobs();
        }

        // Start update loop
        if (this.isMaster) {
            console.log("Starting main update loop");
            setTimeout(() => {
                self.update();
            }, this.UPDATE_INITIAL_DELAY);
        }
    }

    async getJob(id, username) {
        var self = this;

        const job = await this.db.getJob(id);

        if (!job || (username && job.username != username && username != "imicrobe"))
            return;

        return self.createJob(job);
    }

    async getJobs(username) {
        var self = this;
        var jobs;

        if (!username || username == "imicrobe") // let user "imicrobe" see all jobs for all users
            jobs = await this.db.getJobs();
        else
            jobs = await this.db.getJobsForUser(username);

        return jobs.map( job => { return self.createJob(job) } );
    }

    async getActiveJobs() {
        var self = this;

        const jobs = await this.db.getActiveJobs();

        return jobs.map( job => { return self.createJob(job) } );
    }

    createJob(job) {
        return new Job({
            id: job.job_id,
            username: job.username,
            token: job.token,
            appId: job.app_id,
            name: job.name,
            status: job.status,
            inputs: JSON.parse(job.inputs),
            parameters: JSON.parse(job.parameters),
            startTime: job.start_time,
            endTime: job.end_time
        });
    }

    submitJob(job) {
        console.log("JobManager.submitJob", job.id);

        if (!job) {
            console.error("JobManager.submitJob: missing job");
            return;
        }

        return this.db.addJob(job.id, job.username, job.token, job.appId, job.name, job.status, JSON.stringify(job.inputs), JSON.stringify(job.parameters));
    }

    async transitionJob(job, newStatus) {
        console.log('Job.transition: job ' + job.id + ' from ' + job.status + ' to ' + newStatus);
        job.setStatus(newStatus);
        await this.db.updateJob(job.id, job.status, (newStatus == STATUS.FINISHED));
    }

    async runJob(job) {
        var self = this;

        try {
            self.transitionJob(job, STATUS.STAGING_INPUTS);
            await job.stageInputs();
            self.transitionJob(job, STATUS.RUNNING);
            await job.run();
            self.transitionJob(job, STATUS.ARCHIVING);
            await job.archive();
            self.transitionJob(job, STATUS.FINISHED);
        }
        catch (error) {
            console.log('runJob ERROR:', error);
            self.transitionJob(job, STATUS.FAILED);
        }
    }

    async update() {
        var self = this;

        //console.log("Update ...")
        var jobs = await self.getActiveJobs();
        if (jobs && jobs.length) {
            var numJobsRunning = jobs.reduce( (sum, value) => {
                if (value.status == STATUS.STAGING_INPUTS || value.status == STATUS.RUNNING)
                    return sum + 1
                else return sum;
            }, 0 );

            jobs.forEach(
                job => {
//                    console.log("update: job " + job.id + " is " + job.status + " numRunning=" + numJobsRunning);
                    if (numJobsRunning < MAX_JOBS_RUNNING && job.status == STATUS.CREATED) {
                        self.runJob(job);
                        numJobsRunning++;
                    }
                }
            );
        }

        setTimeout(() => {
            self.update();
        }, this.UPDATE_REFRESH_DELAY);
    }
}

class ExecutionSystem {
    constructor(props) {
        this.hostname = props.hostname;
        this.username = props.username;
        this.env = {
            IRODS_ENVIRONMENT_FILE: props.irodsEnvironmentFile || ''
        };
    }

    execute(strOrArray) {
        let self = this;

        let cmdStr = strOrArray;
        if (Array.isArray(strOrArray))
            cmdStr = strOrArray.join(' ');

        let envStr = Object.keys(this.env).map(key => key + "=" + this.env[key]).join(' ');
        let args = [ self.username + '@' + self.hostname, envStr, cmdStr ];
        console.log("Executing remote command: ssh " + args.join(' '));

        return new Promise(function(resolve, reject) {
            const child = proc.execFile(
                'ssh', args,
                { maxBuffer: 10 * 1024 * 1024 }, // 10M -- was overrunning with default 200K
                (error, stdout, stderr) => {
                    console.log('remote_command:stdout:', stdout);
                    console.log('remote_command:stderr:', stderr);

                    if (error) {
                        console.log('remote_command:error:', error);
                        reject(error);
                    }
                    else {
                        resolve(stdout);
                    }
                }
            );
        });
    }
}

function remote_command(hostname, username, strOrArray) {
    let cmdStr = strOrArray;
    if (Array.isArray(strOrArray))
        cmdStr = strOrArray.join(' ');

    var remoteCmdStr = 'ssh ' + username + '@' + hostname + ' ' + cmdStr;
    console.log("Executing remote command: " + remoteCmdStr);

    return new Promise(function(resolve, reject) {
        const child = proc.execFile(
            'ssh', [ config.remoteUsername + '@' + config.remoteHost, cmdStr ],
            { maxBuffer: 10 * 1024 * 1024 }, // 10mb -- was overrunning with default 200kb
            (error, stdout, stderr) => {
                console.log('remote_command:stdout:', stdout);
                console.log('remote_command:stderr:', stderr);

                if (error) {
                    console.log('remote_command:error:', error);
                    reject(error);
                }
                else {
                    resolve(stdout);
                }
            }
        );
    });
}

function local_command(strOrArray) {
    let cmdStr = strOrArray;
    if (Array.isArray(strOrArray))
        cmdStr = strOrArray.join(' ');

    console.log("Executing local command: " + cmdStr);

    return new Promise(function(resolve, reject) {
        const child = proc.exec(
            cmdStr,
            (error, stdout, stderr) => {
                console.log('local_command:stdout:', stdout);
                console.log('local_command:stderr:', stderr);

                if (error) {
                    console.log('local_command:error:', error);
                    reject(error);
                }
                else {
                    resolve(stdout);
                }
            }
        );
    });
}

function remote_copy(local_file) {
    var cmdStr = 'scp ' + local_file + ' ' + config.remoteHost + ':' + config.remoteStagingPath;
    console.log("Copying to remote: " + cmdStr);

    const cmd = proc.spawnSync('scp', [ local_file, config.remoteHost + ':' + config.remoteStagingPath ]);
    console.log( `stderr: ${cmd.stderr.toString()}` );
    console.log( `stdout: ${cmd.stdout.toString()}` );
}

function sharePath(token, path, permission, recursive) {
    var url = config.agaveFilesUrl + "pems/system/data.iplantcollaborative.org" + path;
//    var options = {
//        method: "POST",
//        uri: url,
//        headers: {
//            Accept: "application/json" ,
//            Authorization: token
//        },
//        form: {
//            username: "imicrobe",
//            permission: "READ_WRITE",
//            recursive: recursive
//        },
//        json: true
//    };
//
//    return getPermissions(token, path)
//          .then( permission => {
//              if (permission != "READ_WRITE") {
//                  console.log("Sending POST", url);
//                  return requestp(options);
//              }
//              else
//                  return new Promise((resolve) => { resolve(); });
//          })
//          .catch(function (err) {
//              console.error(err.message);
//              throw(new Error("Agave permissions request failed"));
//          });

    return local_command('curl -sk -H "Authorization: ' + escape(token) + '" -X POST -d "username=imicrobe&permission=' + permission + '&recursive=' + recursive + '" ' + '"' + url + '"');
}

//function getPermissions(token, path) {
//    var url = config.agaveFilesUrl + "pems/system/data.iplantcollaborative.org" + path;
//    var options = {
//        method: "GET",
//        uri: url,
//        headers: {
//            Accept: "application/json" ,
//            Authorization: token
//        },
//        form: {
//            username: "imicrobe",
//            recursive: false
//        },
//        json: true
//    };
//
//    console.log("Sending GET", url);
//    return requestp(options)
//        .then(response => {
//            if (response && response.result) {
//                var user = response.result.find(user => user.username == "imicrobe");
//                if (user && user.permission) {
//                    if (user.permission.write)
//                        return "READ_WRITE";
//                    if (user.permission.read)
//                        return "READ";
//                }
//            }
//
//            return "NONE";
//        });
//}

//function remote_get_file(token, src_path, dest_path) {
//    return remote_command('curl -sk -H "Authorization: ' + escape(token) + '" -o ' + dest_path + ' ' + config.agaveFilesUrl + 'media' + src_path);
//}
//
//function remote_get_directory(token, src_path, dest_path) {
//    return remote_command('curl -sk -H "Authorization: ' + escape(token) + '" ' + config.agaveFilesUrl + 'listings/' + src_path)
//        .then(data => {
//            var response = JSON.parse(data);
//            return response.result;
//        })
//        .each(file => { // transfer one file at a time to avoid "ssh_exchange_identification" error
//            if (file.name != '.') {
//                return remote_get_file(token, file.path, dest_path + '/' + file.name)
//                    .then(() => {
//                        // TODO: move gzip to bzip2 conversion to run_libra.sh ...?
//                        if (file.name.endsWith('.gz') || file.name.endsWith('.gzip')) {
//                            return remote_gzip_to_bzip2(dest_path + '/' + file.name);
//                        }
//                    });
//            }
//        });
//}
//
//function remote_gzip_to_bzip2(src_path) {
//    var path = pathlib.parse(src_path);
//    var dest_path = path.dir + '/' + path.name + '.bz2';
//    return remote_command('gunzip --stdout ' + src_path + ' | bzip2 > ' + dest_path + ' && rm ' + src_path);
//}
//
//function remote_put_file(token, src_path, dest_path) {
//    return remote_command('curl -sk -H "Authorization: ' + escape(token) + '" -X POST -F "fileToUpload=@' + src_path + '" ' + config.agaveFilesUrl + 'media/' + dest_path)
//}
//
//function remote_put_directory(token, src_path, dest_path) {
//    return remote_make_directory(token, dest_path)
//        .then( () => { return remote_command('ls -d -1 ' + src_path + '/*.*') } )
//        .then( ls => {
//            return ls.split("\n");
//        })
//        .each(file => { // transfer one file at a time to avoid "ssh_exchange_identification" error
//            if (file) {
//                return remote_put_file(token, file, dest_path);
//            }
//        });
//}

function agave_mkdir(token, destPath) {
    console.log("Creating remote directory", destPath);
    var path = pathlib.parse(destPath);
    return local_command('curl -sk -H "Authorization: ' + escape(token) + '" -X PUT -d "action=mkdir&path=' + path.base + '" ' + config.agaveFilesUrl + 'media/' + path.dir);
}

function escape(str) {
    str.replace(/\\/g, "\\\\")
       .replace(/\$/g, "\\$")
       .replace(/'/g, "\\'")
       .replace(/"/g, "\\\"");
    return str;
}

exports.Job = Job;
exports.JobManager = JobManager;
