'use strict';

var debug = require('debug')('secc:daemon');
var SECC = require('./settings.json');

var crypto = require('crypto');
var os = require('os');
var path = require('path');

var express = require('express');
var app = express();
var bodyParser = require('body-parser');
var compression = require('compression')
var multer  = require('multer')
var upload = multer({dest:'./uploads/'}).single('source');

var redisClient = null;
if (SECC.daemon.cache) { //cache enabled.
  debug('cache is enabled. set maxmemory and policy');
  redisClient =  require("redis").createClient(SECC.daemon.redis.port
                                    , SECC.daemon.redis.address
                                    , {'return_buffers': true});

  redisClient.on("error", function (err) {
    debug(err);
  });

  redisClient.send_command("config", ['set','maxmemory',SECC.daemon.redis.maxmemory], function(err,replay){
    debug(err);
    debug('redisClient'+replay.toString());
  });
  redisClient.send_command("config", ['set','maxmemory-policy', SECC.daemon.redis['maxmemory-policy']], function(err,replay){
    debug(err);
    debug('redisClient'+ replay.toString());
  });
}

app.use(compression());
app.use(bodyParser.json()); // for parsing application/json
app.use(bodyParser.text()); // for parsing text/plain
app.use(bodyParser.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded
app.use(upload); // for parsing multipart/form-data

var compile = require('./lib/compile.js');
var environment = require('./lib/environment.js');
var utils = require('./lib/utils.js');
app.use(require('morgan')('combined'));

app.use(function(err, req, res, next) {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

process.on('uncaughtException', function (err) {
  console.log('Caught exception: ');
  console.log(err.stack);
});

//SECC.
if (typeof SECC.runPath === 'undefined')
  SECC.runPath = path.join(__dirname, 'run');
if (typeof SECC.uploadsPath === 'undefined')
  SECC.uploadsPath = path.join(__dirname, 'uploads');
if (typeof SECC.toolPath === 'undefined')
  SECC.toolPath = path.join(__dirname, 'tool');


//runtime global val.
var DAEMON = {
  redisClient : redisClient,
  Archives : {
    schedulerArchives : [],
    localPrepArchiveId : [],
    localPrepArchiveIdInProgress : [],

    //FIXME, currently store {pumpArchiveId, archive, archivePath}
    localPumpArchives : [],
    localPumpArchivesInProgress : []
  },
  loadReportTimer : null
}

var schedulerUrl = 'http://' + SECC.daemon.scheduler.address + ':' + SECC.daemon.scheduler.port;
var socket = require('socket.io-client')(schedulerUrl);
socket.on('connect', function(){
  //console.log(socket);
  console.log('socket.io - connected.')

  environment.getGccClangCompilerInformation(function(err, results) {
    if(err) 
      return;

    var daemonInformation = environment.getSystemInformation(SECC);
    
    if(results.gcc)
      daemonInformation.gcc = results.gcc;

    if(results.clang)
      daemonInformation.clang = results.clang;

    daemonInformation.cpus = os.cpus();
    daemonInformation.networkInterfaces = os.networkInterfaces();

    socket.emit('daemonInformation', daemonInformation);

    DAEMON.loadReportTimer = setInterval(function(){
      socket.emit('daemonLoad', { loadavg : os.loadavg()
                                , totalmem : os.totalmem()
                                , freemem : os.freemem()})
    },1000);
  });
});

socket.on('event', function(data){
  console.log(data) ;
});
socket.on('schedulerArchives', function(data){
  //debug(data);
  DAEMON.Archives.schedulerArchives = data;
});
socket.on('clearCache', function(data){
  //debug(data);
  if (SECC.daemon.cache) {
    redisClient.flushdb(function(err, didSucceed){
      debug('redis flushed : %s', didSucceed);
    });
  }
});
socket.on('disconnect', function(){
  console.log('socket.io - disconnected.')

  if (DAEMON.loadReportTimer)
    clearInterval(DAEMON.loadReportTimer);
});

//routers.
var daemonIndex = require('./routes/daemonIndex')(express, socket, SECC, DAEMON);
var daemonNative = require('./routes/daemonNative')(express, socket, SECC, DAEMON);
var daemonCache = require('./routes/daemonCache')(express, socket, SECC, DAEMON);
var daemonCompilePreprocessed = require('./routes/daemonCompilePreprocessed')(express, socket, SECC, DAEMON);
var daemonCompilePump = require('./routes/daemonCompilePump')(express, socket, SECC, DAEMON);

app.use('/', daemonIndex);
app.use('/native/', daemonNative);
app.use('/cache/', daemonCache);
app.use('/compile/preprocessed/', daemonCompilePreprocessed);
app.use('/compile/pump/', daemonCompilePump);

var server = app.listen(SECC.daemon.port, function () {
  var host = server.address().address;
  var port = server.address().port;

  //console.log(server);

  console.log('SECC listening at http://%s:%s', host, port);
});
