#!/bin/bash
#set -x
set -e

IRODS_PATH=$1
JOB_ID=$2
STAGING_PATH=$3
HDFS_PATH=$4

HDFS=/opt/hadoop/bin/hdfs

echo "Started Staging Data" `date`
echo $0 $@

mkdir -p $STAGING_PATH
$HDFS dfs -mkdir -p $HDFS_PATH

filelist=`ils $IRODS_PATH | sed -n '1!p'`
if [[ "$filelist" = "" ]]; then
    filelist=`basename $IRODS_PATH`
    IRODS_PATH=`dirname $IRODS_PATH`
fi

echo "Files: " $filelist

for f in $filelist
do
    echo "Started transferring" $f
    iget -PTf $IRODS_PATH/$f $STAGING_PATH
    echo "Finished transferring" $f

    # Run Illyoung's hashing script -- temporary addition for his thesis
    # mdb removed 3/27/19 -- script reporting "connection refused" error
    #echo "Hashing" $f
    #/home/mbomhoff/bin/hash_blocks.py $STAGING_PATH/$f || true

    ext="${f##*.}"
    name="${f%.*}"

    if [[ "$ext" = "gz" || "$ext" = "gzip" ]]; then
        # mdb removed 9/25/18 -- too slow to convert to bzip2, just decompress 
        #echo "Converting to bzip2" $f
        #gunzip --stdout $STAGING_PATH/$f | /home/mbomhoff/tmp/pbzip2-1.1.8/pbzip2 > $STAGING_PATH/$name.bz2

        echo "Decompressing" $f
        gunzip $STAGING_PATH/$f
        #rm $STAGING_PATH/$f
        f=$name
    fi

    echo "Copying to HDFS" $f
    $HDFS dfs -put -f $STAGING_PATH/$f $HDFS_PATH

    rm $STAGING_PATH/$f
done || exit 1

rm -r $STAGING_PATH

echo "Finished Staging Data" `date`