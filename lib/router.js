'use strict';

const path = require('path');
const _ = require('lodash');
const Bluebird = require('bluebird');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const errorHandler = require('errorhandler');
const express = require('express');
const favicon = require('serve-favicon');
const logger = require('morgan');
const methodOverride = require('method-override');
const mongodb = require('mongodb');

const session = require('express-session');
const db = require('./db');
const routes = require('./routes');
const utils = require('./utils');
var http = require('http');


/**
 * Respond with 401 "Unauthorized".
 *
 * @param {ServerResponse} res
 * @param {String} realm
 * @api private
 */

function unauthorized(res, realm) {
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Basic realm="' + realm + '"');
  res.end('Unauthorized');
};

/**
 * Generate an `Error` from the given status `code`
 * and optional `msg`.
 *
 * @param {Number} code
 * @param {String} msg
 * @return {Error}
 * @api private
 */

function error(code, msg){
  var err = new Error(msg || http.STATUS_CODES[code]);
  err.status = code;
  return err;
};


function basicAuth(callback, realm) {
  var username, password;

  // user / pass strings
  if ('string' == typeof callback) {
    username = callback;
    password = realm;
    if ('string' != typeof password) throw new Error('password argument required');
    realm = arguments[2];
    callback = function(user, pass){
      return user == username && pass == password;
    }
  }

  realm = realm || 'Authorization Required';

  return function(req, res, next) {
    
    if(req.path == '/healthz') return res.send('OK');
    
    var authorization = req.headers.authorization;

    if (req.user) return next();
    if (!authorization) return unauthorized(res, realm);

    var parts = authorization.split(' ');

    if (parts.length !== 2) return next(error(400));

    var scheme = parts[0]
      , credentials = new Buffer(parts[1], 'base64').toString()
      , index = credentials.indexOf(':');

    if ('Basic' != scheme || index < 0) return next(error(400));

    var user = credentials.slice(0, index)
      , pass = credentials.slice(index + 1);

    // async
    if (callback.length >= 3) {
      callback(user, pass, function(err, user){
        if (err || !user)  return unauthorized(res, realm);
        req.user = req.remoteUser = user;
        next();
      });
    // sync
    } else {
      if (callback(user, pass)) {
        req.user = req.remoteUser = user;
        next();
      } else {
        unauthorized(res, realm);
      }
    }
  }
};

const router = async function (config) {
  // appRouter configuration
  const appRouter = express.Router();
  const mongo = await db(config);

  if (config.useBasicAuth) {
    appRouter.use(basicAuth(config.basicAuth.username, config.basicAuth.password));
  }

  appRouter.use(favicon(path.resolve(__dirname, '../public/images/favicon.ico')));

  appRouter.use(logger('dev', config.options.logger));

  appRouter.use('/public', express.static(path.resolve(__dirname, '../build/')));

  // Set request size limit
  appRouter.use(bodyParser.urlencoded({
    extended: true,
    limit: config.site.requestSizeLimit,
  }));

  appRouter.use(cookieParser(config.site.cookieSecret));

  appRouter.use(session({
    key: config.site.cookieKeyName,
    resave: true,
    saveUninitialized: true,
    secret: config.site.sessionSecret,
  }));

  appRouter.use(methodOverride(function (req) {
    if (req.body && typeof req.body === 'object' && '_method' in req.body) {
      // look in urlencoded POST bodies and delete it
      const method = req.body._method;
      delete req.body._method;
      return method;
    }
  }));

  if (process.env.NODE_ENV === 'development') {
    appRouter.use(errorHandler());
  }

  const addTrailingSlash = function (s) {
    return s + (s[s.length - 1] === '/' ? '' : '/');
  };
  const buildBaseHref = function (originalUrl, reqUrl) {
    if (reqUrl === '/') {
      return addTrailingSlash(originalUrl);
    }
    const idx = originalUrl.lastIndexOf(reqUrl);
    const rootPath = originalUrl.substring(0, idx);
    return addTrailingSlash(rootPath);
  };

  // View helper, sets local variables used in templates
  appRouter.all('*', function (req, res, next) {
    res.locals.baseHref       = buildBaseHref(req.originalUrl, req.url);
    res.locals.databases      = mongo.getDatabases();
    res.locals.collections    = mongo.collections;
    res.locals.gridFSBuckets  = utils.colsToGrid(mongo.collections);

    // Flash messages
    if (req.session.success) {
      res.locals.messageSuccess = req.session.success;
      delete req.session.success;
    }

    if (req.session.error) {
      res.locals.messageError = req.session.error;
      delete req.session.error;
    }

    Bluebird.resolve(mongo.updateDatabases()).asCallback((err) => {
      res.locals.databases = mongo.getDatabases();
      next(err);
    });
  });

  // route param pre-conditions
  appRouter.param('database', function (req, res, next, id) {
    // Make sure database exists
    if (!mongo.connections[id]) {
      req.session.error = 'Database not found!';
      return res.redirect(res.locals.baseHref);
    }

    req.dbName = id;
    res.locals.dbName = id;
    res.locals.dbUrl = utils.buildDatabaseURL(res.locals.baseHref, id);

    req.dbConnection = mongo.connections[id];
    req.db = mongo.connections[id].db;
    next();
  });

  // :collection param MUST be preceded by a :database param
  appRouter.param('collection', function (req, res, next, id) {
    // Make sure collection exists

    if (!_.includes(mongo.collections[req.dbName], id)) {
      req.session.error = 'Collection not found!';
      return res.redirect(res.locals.baseHref + 'db/' + req.dbName);
    }

    req.collectionName = id;
    res.locals.collectionName = id;
    res.locals.collectionUrl = utils.buildCollectionURL(res.locals.baseHref, res.locals.dbName, id);

    res.locals.collections = mongo.collections[req.dbName];
    res.locals.gridFSBuckets = utils.colsToGrid(mongo.collections[req.dbName]);

    mongo.connections[req.dbName].db.collection(id, function (err, coll) {
      if (err || coll === null) {
        req.session.error = 'Collection not found!';
        return res.redirect(res.locals.baseHref + 'db/' + req.dbName);
      }

      req.collection = coll;

      next();
    });
  });

  // :document param MUST be preceded by a :collection param
  appRouter.param('document', function (req, res, next, id) {
    if (id === 'undefined' || id === undefined) {
      req.session.error = 'Document lacks an _id!';
      return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
    }

    id = JSON.parse(decodeURIComponent(id));
    let _id;

    try {
      // Case 1 : Object ID
      _id = new mongodb.ObjectID.createFromHexString(id);
    } catch (err) {
      // Case 2 : BinaryID (only subtype 3 and 4)
      if (('subtype' in req.query) && [3, 4].indexOf(req.query.subtype)) {
        _id = new mongodb.Binary(Buffer.from(id, 'base64'), req.query.subtype);
      } else {
        // Case 3 : Try as raw ID
        _id = id;
      }
    }

    const findStraighId = function (id) {
      // No document found with obj_id, try again with straight id
      req.collection.findOne({ _id: id }, function (err, doc) {
        if (err) {
          req.session.error = 'Error: ' + err;
          return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
        }

        if (doc === null) {
          req.session.error = 'Document not found!';
          return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
        }

        // Document found - send it back
        req.document = doc;
        res.locals.document = doc;

        next();
      });
    };

    // If an ObjectID was correctly created from passed id param, try getting the ObjID first else falling back to try getting the string id
    // If not valid ObjectID created, try getting string id
    req.collection.findOne({ _id }, function (err, doc) {
      if (err) {
        req.session.error = 'Error: ' + err;
        return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
      }

      if (doc === null) {
        // No document found with obj_id, try again with straight id
        findStraighId(id);
      } else {
        // Document found - send it back
        req.document = doc;
        res.locals.document = doc;

        next();
      }
    });
  });

  // get individual property - for async loading of big documents
  // (db)/(collection)/(document)/(prop)
  appRouter.param('prop', function (req, res, next, prop) {
    req.prop = req.document[prop];
    next();
  });

  // GridFS (db)/gridFS/(bucket)
  appRouter.param('bucket', function (req, res, next, id) {
    req.bucketName = id;
    res.locals.bucketName = id;

    mongo.connections[req.dbName].collection(id + '.files', function (err, filesConn) {
      if (err || filesConn === null) {
        req.session.error = id + '.files collection not found! Err:' + err;
        return res.redirect(res.locals.baseHref + 'db/' + req.dbName);
      }

      req.filesConn = filesConn;

      filesConn.find({}).toArray(function (err, files) {
        if (err || files === null) {
          req.session.error = id + '.files collection not found! Error:' + err;
          return res.redirect(res.locals.baseHref + 'db/' + req.dbName);
        }

        req.files = files;

        next();
      });
    });
  });

  // GridFS files
  appRouter.param('file', function (req, res, next, id) {
    req.fileID = JSON.parse(decodeURIComponent(id));
    next();
  });

  // mongodb mongoMiddleware
  const mongoMiddleware = function (req, res, next) {
    req.mainClient = mongo.mainClient;
    req.adminDb = mongo.adminDb;
    req.databases = mongo.getDatabases(); // List of database names
    req.collections = mongo.collections; // List of collection names in all databases
    req.gridFSBuckets = utils.colsToGrid(mongo.collections);

    // Allow page handlers to request an update for collection list
    req.updateCollections = mongo.updateCollections;
    req.updateDatabases = mongo.updateDatabases;

    next();
  };

  // routes
  const configuredRoutes = routes(config);

  appRouter.get('/', mongoMiddleware, configuredRoutes.index);
  appRouter.post('/', mongoMiddleware, configuredRoutes.addDatabase);
  appRouter.delete('/:database', mongoMiddleware, configuredRoutes.deleteDatabase);
  appRouter.get('/db/:database', mongoMiddleware, configuredRoutes.viewDatabase);

  appRouter.post('/checkValid', mongoMiddleware, configuredRoutes.checkValid);

  // Collection level routes
  appRouter.post('/db/:database/import/:collection', mongoMiddleware, configuredRoutes.importCollection);
  appRouter.get('/db/:database/compact/:collection', mongoMiddleware, configuredRoutes.compactCollection);
  appRouter.get('/db/:database/expArr/:collection', mongoMiddleware, configuredRoutes.exportColArray);
  appRouter.get('/db/:database/expCsv/:collection', mongoMiddleware, configuredRoutes.exportCsv);
  appRouter.get('/db/:database/reIndex/:collection', mongoMiddleware, configuredRoutes.reIndex);
  appRouter.post('/db/:database/addIndex/:collection', mongoMiddleware, configuredRoutes.addIndex);
  appRouter.get('/db/:database/export/:collection', mongoMiddleware, configuredRoutes.exportCollection);
  appRouter.get('/db/:database/dropIndex/:collection', mongoMiddleware, configuredRoutes.dropIndex);
  appRouter.get('/db/:database/updateCollections', mongoMiddleware, configuredRoutes.updateCollections);

  // GridFS
  appRouter.post('/db/:database/gridFS', mongoMiddleware, configuredRoutes.addBucket);
  appRouter.delete('/db/:database/gridFS/:bucket', mongoMiddleware, configuredRoutes.deleteBucket);

  appRouter.get('/db/:database/gridFS/:bucket', mongoMiddleware, configuredRoutes.viewBucket);
  appRouter.post('/db/:database/gridFS/:bucket', mongoMiddleware, configuredRoutes.addFile);
  appRouter.get('/db/:database/gridFS/:bucket/:file', mongoMiddleware, configuredRoutes.getFile);
  appRouter.delete('/db/:database/gridFS/:bucket/:file', mongoMiddleware, configuredRoutes.deleteFile);

  appRouter.get('/db/:database/:collection', mongoMiddleware, configuredRoutes.viewCollection);
  appRouter.put('/db/:database/:collection', mongoMiddleware, configuredRoutes.renameCollection);
  appRouter.delete('/db/:database/:collection', mongoMiddleware, configuredRoutes.deleteCollection);
  appRouter.post('/db/:database', mongoMiddleware, configuredRoutes.addCollection);

  // Document routes
  appRouter.post('/db/:database/:collection', mongoMiddleware, configuredRoutes.addDocument);
  appRouter.get('/db/:database/:collection/:document', mongoMiddleware, configuredRoutes.viewDocument);
  appRouter.put('/db/:database/:collection/:document', mongoMiddleware, configuredRoutes.updateDocument);
  appRouter.delete('/db/:database/:collection/:document', mongoMiddleware, configuredRoutes.deleteDocument);

  // Property routes
  appRouter.get('/db/:database/:collection/:document/:prop', mongoMiddleware, configuredRoutes.getProperty);

  return appRouter;
};

module.exports = router;
