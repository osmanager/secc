'use strict';

var debug = require('debug')('secc:' + process.pid + ':routes:daemonCompilePreprocessed');

var path = require('path');
var querystring = require('querystring');
var stream = require('stream');
var zlib = require('zlib');

var compile = require('../lib/compile.js');
var utils = require('../lib/utils.js');

module.exports = function(express, SECC, DAEMON) {
  var router = express.Router();

  var Archives = DAEMON.Archives;
  var redisClient = DAEMON.redisClient;

  var compileWrapper = function(req, res, archive, options) {
    var jobId = req.headers['x-secc-jobid'] || null;
    if (jobId) DAEMON.worker.emitToScheduler('compileBefore', { jobId: jobId });

    var contentEncoding = req.headers['content-encoding'];
    options = options || {};
    options.compiler = archive.compiler;
    options.driver = req.headers['x-secc-driver'] || archive.compiler;

    try {
      options.argv = [];
      options.argv = JSON.parse(req.headers['x-secc-argv']);
    } catch (e) {}

    var output;

    if (req.headers['x-secc-language'] !== undefined)
      options.language = req.headers['x-secc-language'];

    if (req.headers['x-secc-filename'] !== undefined)
      options.fileName = req.headers['x-secc-filename'];

    if (req.headers['x-secc-outfile'] !== undefined)
      options.outfile = req.headers['x-secc-outfile'];

    if (req.headers['x-secc-cross'] !== undefined)
      options.cross = (req.headers['x-secc-cross'] == 'true') ? true : false;
    if (req.headers['x-secc-target'] !== undefined)
      options.target = req.headers['x-secc-target'];

    // using stdin pipe
    options.usingPipe = true;

    // cache
    if (SECC.daemon.cache) {
      debug('using redis cache.');
      options.cache = true;
      options.redisClient = redisClient;
    }

    var compilePipeStream = new compile.CompileStream(options);

    compilePipeStream.on('cacheStored', function(data) {
      DAEMON.worker.emitToScheduler('cacheStored', data);
    });

    compilePipeStream.on('error', function(err) {
      debug(err);
      this.cleanup();
      res.status(400).send(err.message);
    });

    compilePipeStream.on('finish', function(err, stdout, stderr, code, outArchive) {
      if (stdout) res.setHeader('x-secc-stdout', querystring.escape(stdout));
      if (stderr) res.setHeader('x-secc-stderr', querystring.escape(stderr));
      if (code || code == 0) res.setHeader('x-secc-code', code);

      if (err) {
        // FIXME : require error reporting.
        debug('compilePipeStream compile ERROR!!');
        debug(err);
        debug(stderr);

        if (jobId) DAEMON.worker.emitToScheduler('compileAfter', { jobId: jobId,  error: err.message });

        return res.status(400).send(err.message);
      }

      res.attachment(outArchive);
      res.writeHead(200);
      output.pipe(res);

      if (jobId) DAEMON.worker.emitToScheduler('compileAfter', { jobId: jobId });
    });

    // pipe magic. req -> (unzip) -> CompileStream -> on'finish' -> res
    output = req.pipe(
      contentEncoding === 'gzip'
        ? zlib.createGunzip()
        : (contentEncoding === 'deflate'
          ? zlib.createInflate()
          : stream.PassThrough())
    ).on('error', function(err) {
      compilePipeStream.emit('error', err);
    }).pipe(compilePipeStream);
  };

  router.post('/:archiveId', function(req, res) {
    var archive, options;
    var jobId = req.headers['x-secc-jobid'] || null;
    var archiveId = req.params.archiveId;

    if (Archives.localArchives.hasOwnProperty(archiveId)) {
      archive = Archives.localArchives[archiveId];
      options = {
        buildNative: true,
        archiveId: archiveId
      };

      return compileWrapper(req, res, archive, options);
    }

    archive = utils.getArchiveInArray(Archives.schedulerArchives, archiveId);

    // check exists in Archives.schedulerArchives
    if (!utils.archiveExistsInArray(Archives.schedulerArchives, archiveId)) {
      debug('unknown archiveId. not exists in Archives.schedulerArchives.');

      if (jobId) DAEMON.worker.emitToScheduler('compileLocal', { jobId: jobId });
      return res.status(400).send('unknown archiveId.');
    }

    // check WIP in Archives.localPrepArchiveIdInProgress.
    if (Archives.localPrepArchiveIdInProgress.hasOwnProperty(archiveId)) {
      debug('archiveId %s is working in progress.', archiveId);
      if (jobId) DAEMON.worker.emitToScheduler('compileLocal', { jobId: jobId });
      return res.status(400).send('archiveId is working in progress.');
    }

    // check in localPrepArchiveIdInProgress(already installed or not)
    if (!Archives.localPrepArchiveId.hasOwnProperty(archiveId)) {
      debug('archiveId %s is not installed. will be install.', archiveId);
      Archives.localPrepArchiveIdInProgress[archiveId] = new Date();
      DAEMON.worker.broadcast('addLocalPrepArchiveIdInProgress', {archiveId: archiveId });

      // request 'Install Archive' to the master
      DAEMON.worker.emitToMaster('requestInstallArchive', {archiveId: archiveId });

      if (jobId) DAEMON.worker.emitToScheduler('compileLocal', { jobId: jobId });
      return res.status(400).send('archiveId is not installed.');
    }

    options = {
      buildNative: false,
      archiveId: archive.archiveId,
      buildRoot: path.join(SECC.runPath, 'preprocessed', archive.archiveId)
    };

    compileWrapper(req, res, archive, options);
  });

  return router;
};
