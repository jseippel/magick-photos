var async = require('async');
var gm = require('gm').subClass({ imageMagick: true }); // Enable ImageMagick integration.
var util = require('util');
var AWS = require('aws-sdk');
var piexif = require('piexifjs');

var DST_BUCKET = process.env.DESTINATION_BUCKET;
var MAX_WIDTH = process.env.MAX_WIDTH;
var MAX_HEIGHT = process.env.MAX_HEIGHT;

var s3 = new AWS.S3();

exports.handler = function(event, context, callback) {
    // Read options from the event.
    console.log(
        'Reading options from event:\n',
        util.inspect(event, { depth: 5 })
    );
    var srcBucket = event.Records[0].s3.bucket.name;
    // Object key may have spaces or unicode non-ASCII characters.
    var srcKey = decodeURIComponent(
        event.Records[0].s3.object.key.replace(/\+/g, ' ')
    );
    var dstKey = srcKey;

    // Infer the image type.
    var typeMatch = srcKey.match(/\.([^.]*)$/);
    if (!typeMatch) {
        callback('Could not determine the image type.');
        return;
    }
    var imageType = typeMatch[1];
    if (imageType != 'jpg' && imageType != 'png') {
        callback('Unsupported image type: ${imageType}');
        return;
    }

    // Download the image from S3, transform, and upload to a different S3 bucket.
    async.waterfall(
        [
            function download(next) {
                // Download the image from S3 into a buffer.
                s3.getObject(
                    {
                        Bucket: srcBucket,
                        Key: srcKey
                    },
                    next
                );
            },
            function transform(response, next) {
                console.log('transforming ' + srcKey + '...');
                gm(response.Body).size(function(err, size) {
                    console.log(response.Body);
                    console.log(size);
                    // Infer the scaling factor to avoid stretching the image unnaturally.
                    var scalingFactor = Math.min(
                        MAX_WIDTH / size.width,
                        MAX_HEIGHT / size.height
                    );
                    var width = scalingFactor * size.width;
                    var height = scalingFactor * size.height;

                    // Transform the image buffer in memory.
                    console.log('resizing... ' + width + ' x ' + height);
                    this.resize(width, height);
                    console.log('watermarking...');
                    this.draw([
                        'gravity SouthEast image Over 128,128 512,512 "hip-logo-bw-transparent.png"'
                    ]);
                    console.log('to buffer... ' + imageType);
                    this.toBuffer(imageType, function(err, buffer) {
                        if (err) {
                            next(err);
                        } else {
                            next(null, response.ContentType, buffer);
                        }
                    });
                });
            },
            function copyright(contentType, data, next) {
                console.log('copyrighting...');
                console.log(contentType);
                console.log(data);
                var jpegData = data.toString('binary');
                var exifObj = piexif.load(jpegData);
                console.log(exifObj);
                exifObj['0th'][piexif.ImageIFD.Copyright] =
                    'Copyright (c) 2017 Will Seippel';
                console.log(exifObj);
                var exifBytes = piexif.dump(exifObj);
                var newData = piexif.insert(exifBytes, jpegData);

                var buffer = Buffer.from(newData, 'binary');
                next(null, contentType, buffer);
            },
            function upload(contentType, data, next) {
                console.log('uploading...');
                // Stream the transformed image to a different S3 bucket.
                s3.putObject(
                    {
                        Bucket: DST_BUCKET,
                        Key: dstKey,
                        Body: data,
                        ContentType: contentType
                    },
                    next
                );
            }
        ],
        function(err) {
            if (err) {
                console.error(
                    'Unable to resize ' +
                        srcBucket +
                        '/' +
                        srcKey +
                        ' and upload to ' +
                        DST_BUCKET +
                        '/' +
                        dstKey +
                        ' due to an error: ' +
                        err
                );
            } else {
                console.log(
                    'Successfully resized ' +
                        srcBucket +
                        '/' +
                        srcKey +
                        ' and uploaded to ' +
                        DST_BUCKET +
                        '/' +
                        dstKey
                );
            }

            callback(null, 'message');
        }
    );
};
