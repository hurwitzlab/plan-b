const spawn = require('child_process').spawnSync;
const pathlib = require('path');
const shortid = require('shortid');
const config = require('../../config.json');


const STATUS = {
    CREATED:         1,
    STAGING_INPUTS:  2,
    RUNNING:         3,
    PUSHING_OUTPUTS: 4,
    FINISHED:        5,
    FAILED:          6
}

function statusToString(value) {
    return Object.keys(STATUS).find(key => STATUS[key] === value);
}

var jobs = {};

class Job {
    constructor(props) {
        this.id = 'planb-' + shortid.generate();
        this.name = props.name;
        this.appId = props.appId;
        this.inputs = props.inputs;
        this.parameters = props.parameters;
        this.status = STATUS.CREATED;
        console.log('Create job ' + this.id);
    }

    transition(newStatus) {
        console.log('Transition job ' + this.id + ' to ' + statusToString(newStatus));
        this.status = newStatus;
    }

    submit() {
        jobs[this.id] = this;
    }

    stageInputs() {
        if (!this.inputs)
            return;

        console.log(this.inputs);

        var staging_path = config.remoteStagingPath + '/' + this.id + '/data/';
        var target_path = config.remoteTargetPath + '/' + this.id + '/data/';

        remote_command('mkdir -p ' + staging_path);

        remote_command('hdfs dfs -mkdir -p ' + target_path);

        Object.values(this.inputs).forEach( path => {
            console.log('Job ' + this.id + ': staging input: ' + path);
            path = '/iplant/home' + path;
            var base = pathlib.basename(path);
            remote_command(
                'cd ' + staging_path + ' && iget -frTK ' + path
            );
            remote_command(
                'cd ' + staging_path + ' && hdfs dfs -put ' + base + ' ' + target_path + base
            );
        });
    }

    run() {
        var KMER_SIZE = this.parameters.KMER_SIZE || 20;
        var FILTER_ALG = this.parameters.FILTER_ALG || "NOTUNIQUE";
        var NUM_TASKS = this.parameters.NUM_TASKS || 1;
        var RUN_MODE = this.parameters.RUN_MODE || "map";
        var WEIGHTING_ALG = this.parameters.WEIGHTING_ALG || "LOGALITHM";

        var target_path = config.remoteTargetPath + '/' + this.id + '/data/';
        var input_path = target_path + pathlib.basename(this.inputs.IN_DIR);
        var run_script = config.remoteStagingPath + '/run_libra.sh';

        // Copy job execution script to remote system
        remote_copy('./run_libra.sh');

        // FIXME is 'nohup' necessary?  And '&' isn't working
        remote_command('nohup sh ' + run_script + ' ' + this.id + ' ' + input_path + ' ' + KMER_SIZE + ' ' + NUM_TASKS + ' ' + FILTER_ALG + ' ' + RUN_MODE + ' ' + WEIGHTING_ALG + ' &');
    }

    pushOutputs() {
        var staging_path = config.remoteStagingPath + '/' + this.id;
        var ds_output_path = '/iplant/home/' + config.remoteUsername + '/analyses/' + 'occ-' + this.id

        remote_command('iput -KTr ' + staging_path + '/score' + ' ' + ds_output_path);
    }

    statusString() {
        return statusToString(this.status);
    }
}

function get(id) {
    console.log("get ", id, jobs);
    if (typeof id == 'undefined')
        return jobs;
    else
        return jobs[id];
}

function update() {
    //console.log("Update ...")
    Object.values(jobs).forEach(job => {
        if (job.status == STATUS.CREATED) {
            job.transition(STATUS.STAGING_INPUTS);
            job.stageInputs();
        }
        else if (job.status == STATUS.STAGING_INPUTS) {
            job.transition(STATUS.RUNNING);
            job.run();
        }
        else if (job.status == STATUS.RUNNING) {
            job.transition(STATUS.PUSHING_OUTPUTS);
            job.pushOutputs();
        }
        else if (job.status == STATUS.PUSHING_OUTPUTS) {
            job.transition(STATUS.FINISHED)
        }
    });

    setTimeout(() => {
        update();
    }, 1000);
}

function remote_command(cmd_str) {
    var remoteCmdStr = 'ssh ' + config.remoteUsername + '@' + config.remoteHost + ' ' + cmd_str;
    console.log("Executing remote command: " + remoteCmdStr);

    const cmd = spawn('ssh', [ config.remoteUsername + '@' + config.remoteHost, cmd_str ]);
    console.log( `stderr: ${cmd.stderr.toString()}` );
    console.log( `stdout: ${cmd.stdout.toString()}` );

    return {
        stderr: cmd.stderr.toString(),
        stdout: cmd.stdout.toString()
    }
}

function remote_copy(local_file) {
    var cmdStr = 'scp ' + local_file + ' ' + config.remoteHost + ':' + config.remoteStagingPath;
    console.log("Copying to remote: " + cmdStr);

    const cmd = spawn('scp', [ local_file, config.remoteHost + ':' + config.remoteStagingPath ]);
    console.log( `stderr: ${cmd.stderr.toString()}` );
    console.log( `stdout: ${cmd.stdout.toString()}` );
}

function init() {
    console.log("init");

    // Start update loop
    setTimeout(() => {
        update();
    }, 5000);
}

exports.Job = Job;
exports.get = get;
exports.init = init;