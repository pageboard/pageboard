var tag = require('upcache/tag');
var pify = require('util').promisify;
var fs = {
	readFile: pify(require('fs').readFile),
	writeFile: pify(require('fs').writeFile),
	statSync: pify(require('fs').statSync)
};
var Glob = require('glob').Glob;
var Path = require('path');
var Stringify = require('fast-json-stable-stringify');
var crypto = require('crypto');
var got = require('got');

var state = new CacheState();

exports = module.exports = function(opt) {
	exports.tag = tag;
	exports.disable = tag.disable;
	exports.install = state.install.bind(state);
	return {
		init: function(All) {
			return state.init(All).then(function() {
				All.app.get('*', tag('app'));
				All.app.post('/.well-known/upcache', state.mw.bind(state), function(req, res) {
					res.sendStatus(204);
				});
			});
		},
		name: 'cache'
	};
};

function CacheState() {
	this.mtime = 0;
}

CacheState.prototype.init = function(All) {
	this.opt = All.opt;
	this.path = Path.join(opt.dirs.data, 'cache.json');
	this.mtimes = {};
	return this.open();
};

CacheState.prototype.saveNow = function() {
	delete this.toSave;
	var me = this;
	return fs.writeFile(this.path, JSON.stringify(this.data)).catch(function(err) {
		console.error("Error writing", me.path);
	});
};

CacheState.prototype.save = function() {
	if (this.toSave) clearTimeout(this.toSave);
	this.toSave = setTimeout(this.saveNow.bind(this), 5000);
};

CacheState.prototype.open = function() {
	var me = this;
	return fs.readFile(this.path, {flag: 'a+'}).then(function(buf) {
		var str = buf.toString();
		if (!str) return;
		return JSON.parse(str);
	}).catch(function(err) {
		console.info(`Unparsable ${me.path}, continuing anyway`);
	}).then(function(data) {
		me.data = data || {};
		if (!me.data.sites) me.data.sites = {};
	});
};

CacheState.prototype.install = function(site) {
	setTimeout(function() {
		got.post(`${site.href}/.well-known/upcache`).catch(function(err) {
			console.error(err);
		});
	});
};

CacheState.prototype.mw = function(req, res, next) {
	var me = this;
	var tags = [];
	var doSave = false;
	var id = req.site.id;
	var dobj = this.data.sites[id];
	if (!dobj) dobj = this.data.sites[id] = {};
	console.info("Check cache for", id);

	if (!this.digest) {
		var hash = crypto.createHash('sha256');
		hash.update(Stringify(this.opt));
		this.hash = hash.digest('hex');
	}
	if (dobj.hash === undefined) {
		doSave = true;
		dobj.hash = this.hash;
	} else if (dobj.hash != this.hash) {
		doSave = true;
		dobj.hash = this.hash;
		tags.push('app');
	}
	this.refreshMtime().then(function(mtime) {
		if (dobj.share === undefined) {
			doSave = true;
			dobj.share = mtime;
		} else if (mtime > dobj.share) {
			doSave = true;
			dobj.share = mtime;
			tags.push('shared');
		}
		return me.refreshMtime(id);
	}).then(function(mtime) {
		if (dobj.file === undefined) {
			doSave = true;
			dobj.file = mtime;
		} else if (mtime > dobj.file) {
			doSave = true;
			dobj.file = mtime;
			tags.push('file');
		}
	}).then(function() {
		if (tags.length) {
			console.info(` up tags: ${tags.join(' ')}`);
			tag.apply(null, tags)(req, res, next);
		} else {
			next();
		}
		if (doSave) me.save();
	}).catch(function(err) {
		console.error("Error in cacheState mw", err);
	});
}

CacheState.prototype.refreshMtime = function(id) {
	var dir = Path.join(this.opt.statics.runtime, id ? 'files/' + id : 'pageboard');
	var mtime;
	if (!id) {
		// do not actually refresh every time
		mtime = this.mtimes.pageboard;
		if (mtime) return Promise.resolve(mtime);
	}
	mtime = 0;
	var pattern = dir + '/**';
	var me = this;

	return new Promise(function(resolve, reject) {
		var g = new Glob(pattern, {
			follow: true, // symlinks
			stat: true,
			nodir: true
		});
		g.on('stat', function(file, stat) {
			var ftime = stat.mtime.getTime();
			if (ftime > mtime) mtime = ftime;
		})
		g.on('end', function() {
			me.mtimes[id || 'pageboard'] = mtime;
			resolve(mtime);
		});
		// not sure if end always happen, nor if error happens once
		// g.on('error', reject)
	});
};
