var pify = require('util').promisify;
if (!pify) pify = require('util').promisify = require('util-promisify');
var Path = require('path');
var express = require('express');
var bodyParserJson = require('body-parser').json();
var morgan = require('morgan');
var pad = require('pad');
var prettyBytes = require('pretty-bytes');
var rc = require('rc');
var mkdirp = pify(require('mkdirp'));
var xdg = require('xdg-basedir');
var pkgup = require('pkg-up');
var PQueue = require('p-queue');
var equal = require('esequal');
var debug = require('debug')('pageboard:core');

var fs = {
	writeFile: pify(require('fs').writeFile),
	readFile: pify(require('fs').readFile),
	readdir: pify(require('fs').readdir),
	stat: pify(require('fs').stat),
	unlink: pify(require('fs').unlink)
};

var npm = require('npm');
var npmQueue = new PQueue({concurrency: 1});

// exceptional but so natural
global.HttpError = require('http-errors');

exports.config = function(pkgOpt) {
	var cwd = process.cwd();
	pkgOpt = Object.assign({}, require(cwd + '/package.json'), pkgOpt);
	var name = pkgOpt.name;
	var opt = rc(name, {
		cwd: cwd,
		env: pkgOpt.env || process.env.NODE_ENV || 'development',
		name: name,
		version: pkgOpt.version,
		global: true,
		listen: 3000,
		logFormat: ':method :status :time :size :type :url',
		dirs: {
			cache: Path.join(xdg.cache, name),
			data: Path.join(xdg.data, name),
			runtime: Path.join(xdg.runtime, name)
		},
		elements: [],
		directories: [],
		plugins: [],
		dependencies: pkgOpt.dependencies || {}
	});
	return opt;
};

exports.init = function(opt) {
	var app = createApp(opt);

	var All = {
		app: app,
		opt: opt
	};
	All.query = reqQuery.bind(All);
	All.body = reqBody.bind(All);
	All.install = install.bind(All);

	if (opt.global) global.All = All;

	Object.keys(opt.dependencies).forEach(function(module) {
		opt.plugins.push(module);
	});

	var pluginList = [];

	while (opt.plugins.length) {
		var module = opt.plugins.shift();
		var plugin = require(module);
		if (typeof plugin != "function") continue;
		var obj = plugin(opt) || {};
		obj.plugin = plugin;
		pluginList.push(obj);
	}

	All.log = initLog(opt);

	return Promise.all(Object.keys(opt.dependencies).map(function(module) {
		return pkgup(require.resolve(module)).then(function(pkgPath) {
			return initConfig(Path.dirname(pkgPath), null, module, All.opt);
		});
	})).then(function() {
		return initDirs(opt.dirs);
	}).then(function() {
		return initPlugins.call(All, pluginList);
	}).then(function() {
		return initPlugins.call(All, pluginList, 'file');
	}).then(function() {
		app.use(filesError);
		app.use(All.log);
		return initPlugins.call(All, pluginList, 'service');
	}).then(function() {
		app.use(servicesError);
		return initPlugins.call(All, pluginList, 'view');
	}).then(function() {
		return All.statics.install({mounts: All.opt.directories, domain: 'pageboard'});
	}).then(function() {
		return All.api.install({elements: All.opt.elements, directories: All.opt.directories});
	}).then(function() {
		app.use(viewsError);
		return All;
	});
}

function initDirs(dirs) {
	return Promise.all(Object.keys(dirs).map(function(key) {
		return mkdirp(dirs[key]);
	}));
}

function initPlugins(plugins, type) {
	var All = this;
	plugins = plugins.filter(function(obj) {
		if (type && !obj[type]) return false;
		if (!type && (obj.file || obj.service || obj.view)) return false;
		return true;
	}).sort(function(a, b) {
		return (a.priority || 0) <= (b.priority || 0);
	});
	var p = Promise.resolve();
	plugins.forEach(function(obj) {
		var to;
		if (obj.name) {
			to = All[obj.name] = All[obj.name] || {};
		} else {
			to = All;
		}
		if (type) p = p.then(() => obj[type].call(obj, All));
		p = p.then(function() {
			var plugin = obj.plugin = Object.assign({}, obj.plugin); // make a copy
			Object.keys(plugin).forEach(function(key) {
				if (to[key] !== undefined) throw new Error(`module conflict ${obj.name}.${key}`);
				to[key] = plugin[key];
				delete plugin[key]; // we made a copy before
			});
		});
	});
	return p.catch(function(err) {
		console.error(err);
	});
}

function initLog(opt) {
	morgan.token('method', function(req, res) {
		return pad(req.method, 4);
	});
	morgan.token('status', function(req, res) {
		return pad(3, res.statusCode);
	});
	morgan.token('time', function(req, res) {
		var ms = morgan['response-time'](req, res, 0);
		if (ms) return pad(4, ms) + 'ms';
		else return pad(6, '');
	});
	morgan.token('type', function(req, res) {
		return pad(4, (res.get('Content-Type') || '-').split(';').shift().split('/').pop());
	});
	morgan.token('size', function(req, res) {
		var len = parseInt(res.get('Content-Length'));
		return pad(6, (len && prettyBytes(len) || '0 B').replace(/ /g, ''));
	});

	return morgan(opt.logFormat);
}

function install({domain, dependencies}) {
	if (!domain) throw new Error("Missing domain");
	var All = this;
	var dataDir = Path.join(All.opt.dirs.data, 'sites');
	var domainDir = Path.join(dataDir, domain);
	var config = {
		directories: [],
		elements: []
	};
	var pkgFile = Path.join(domainDir, 'package.json');
	return mkdirp(domainDir).then(function() {
		debug("Trying dependency", pkgFile);
		var doInstall = true;
		return fs.readFile(pkgFile).then(function(json) {
			var obj = JSON.parse(json);
			if (equal(obj.dependencies, dependencies)) doInstall = false;
		}).catch(function(ex) {
			// whatever
			debug("Error reading dependency", ex);
		}).then(function() {
			if (!doInstall) return;
			return fs.writeFile(pkgFile, JSON.stringify({
				name: domain,
				dependencies: dependencies
			}));
		}).then(function() {
			if (!doInstall) return;
			return npmInstall(domainDir);
		});
	}).then(function(data) {
		return Promise.all(Object.keys(dependencies || {}).map(function(module) {
			return initConfig(Path.join(domainDir, 'node_modules', module), domain, module, config);
		}));
	}).then(function() {
		return All.statics.install({mounts: config.directories, domain: domain});
	}).then(function() {
		return All.api.install({elements: config.elements, directories: config.directories, domain: domain});
	}).then(function() {
		return config;
	});
};

function npmInstall(domainDir) {
	debug("Installing dependencies", domainDir);
	return npmQueue.add(function() {
		return fs.unlink(Path.join(domainDir, 'package-lock.json')).catch(function(){})
		.then(function() {
			return new Promise(function(resolve, reject) {
				npm.load({
					prefix: domainDir,
					'ignore-scripts': true,
					only: 'prod',
					loglevel: 'silent',
					silent: true,
					progress: false
				}, function(err) {
					if (err) return reject(err);
					npm.commands.install(function(err, data) {
						if (err) reject(err);
						else resolve(data);
					});
				});
			});
		});
	});
}

function initConfig(moduleDir, domain, module, config) {
	debug("Module directory", module, moduleDir);
	return fs.readFile(Path.join(moduleDir, 'package.json')).catch(function(err) {
		// it's ok to not have a package.json here
		return false;
	}).then(function(buf) {
		if (buf === false) {
			console.info(`${domain} > ${module} has no package.json, mounting the module directory`);
			config.directories.push({
				from: Path.resolve(moduleDir),
				to: domain ? Path.join('/', '.files', domain, module) : '/.pageboard'
			});
			return;
		}
		var meta = JSON.parse(buf);
		if (!meta.pageboard) return; // nothing to do
		var directories = meta.pageboard.directories || [];
		if (!Array.isArray(directories)) directories = [directories];
		debug("processing directories", directories);
		directories.forEach(function(mount) {
			if (typeof mount == "string") mount = {
				from: mount,
				to: mount
			};
			var from = Path.resolve(moduleDir, mount.from);
			if (from.startsWith(moduleDir) == false) {
				console.warn(`Warning: ${domain} dependency ${module} bad mount from: ${from}`);
				return;
			}
			var rootTo = domain ? Path.join('/', '.files', domain, module) : '/.pageboard';
			var to = Path.resolve(rootTo, mount.to);
			if (to.startsWith(rootTo) == false) {
				console.warn(`Warning: ${domain} dependency ${module} bad mount to: ${to}`);
				return;
			}
			config.directories.push({
				from: from,
				to: to
			});
		});

		var elements = meta.pageboard.elements || [];
		if (!Array.isArray(elements)) elements = [elements];
		debug("processing elements", elements);
		return Promise.all(elements.map(function(path) {
			var absPath = Path.resolve(moduleDir, path);
			return fs.stat(absPath).then(function(stat) {
				if (stat.isDirectory()) return fs.readdir(absPath).then(function(paths) {
					return paths.map(function(path) {
						return Path.join(absPath, path);
					});
				});
				else return [absPath];
			}).then(function(paths) {
				paths.forEach(function(path) {
					if (path.endsWith('.js')) config.elements.push(path);
				});
			});
		}));
	}).catch(function(err) {
		console.error(`Error: ${domain} dependency ${module} cannot be extracted`, err);
	});
}

function createApp(opt) {
	var app = express();
	// https://www.smashingmagazine.com/2017/04/secure-web-app-http-headers/
	app.set("env", opt.env);
	app.disable('x-powered-by');
	app.use(function(req, res, next) {
		res.setHeader('X-XSS-Protection','1;mode=block');
		res.setHeader('X-Frame-Options', 'SAMEORIGIN');
		if (opt.env != "development") res.setHeader('Content-Security-Policy', "script-src 'self'");
		res.setHeader('X-Content-Type-Options', 'nosniff');
		next();
	});
	return app;
}

function servicesError(err, req, res, next) {
	var msg = err.message || err.toString();
	var fullCode = err.statusCode || err.code;
	var code = parseInt(fullCode);
	if (isNaN(code) || code < 200 || code >= 600) {
		msg += "\nerror code: " + fullCode;
		code = 500;
	}
	if (All.opt.env == "development" || code >= 500) console.error(err);
	if (msg) res.status(code).send(msg);
	else res.sendStatus(code);
}

function filesError(err, req, res, next) {
	var code = parseInt(err.statusCode || err.code);
	if (isNaN(code) || code < 200 || code >= 600) {
		code = 500;
	}
	if (code >= 400) All.log(req, res, function() {
		res.sendStatus(code);
	});
	else res.sendStatus(code);
}

function viewsError(err, req, res, next) {
	var code = parseInt(err.statusCode || err.code);
	if (isNaN(code) || code < 200 || code >= 600) {
		code = 500;
	}
	if (All.opt.env == "development" || code >= 500) console.error(err);
	res.redirect(req.app.settings.errorLocation + '?code=' + code);
}

function reqBody(req, res, next) {
	var opt = this.opt;
	bodyParserJson(req, res, function() {
		var obj = req.body;
		// all payloads must contain domain
		obj.domain = req.hostname;
		next();
	});
}

function reqQuery(req, res, next) {
	var obj = req.query;
	// all payloads must contain domain
	obj.domain = req.hostname;
	next();
}

