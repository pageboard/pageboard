var serveStatic = require('serve-static');
var Path = require('path');
var pify = require('util').promisify;
var fs = {
	symlink: pify(require('fs').symlink),
	unlink: pify(require('fs').unlink)
};

var mkdirp = pify(require('mkdirp'));
var rimraf = pify(require('rimraf'));

var debug = require('debug')('pageboard-static');

exports = module.exports = function(opt) {
	if (!opt.statics) opt.statics = {};
	var statics = opt.statics;
	if (!statics.runtime) {
		statics.runtime = Path.join(opt.dirs.runtime, 'statics');
	} else {
		statics.runtime = Path.resolve(statics.runtime);
	}

	if (!statics.maxAge) statics.maxAge = 3600;
	if (opt.env == 'development') statics.maxAge = 0;

	return {
		name: 'statics',
		file: init
	};
};

function init(All) {
	var statics = All.opt.statics;
	var app = All.app;

	return mkdirp(statics.runtime).then(function() {
		console.info(`Static directories are served from symlinks in ${statics.runtime}`);

		app.get(
			"/:dir(.pageboard|.files|.uploads)/*",
			function(req, res, next) {
				switch(req.params.dir) {
					case ".pageboard":
						req.url = "/" + req.url.substring(2);
						break;
					case ".uploads":
						req.url = "/uploads/" + req.hostname + req.url.substring(9);
						break;
					case ".files":
						req.url = "/files/" + req.hostname + req.url.substring(7);
						break;
				}
				console.log("rewritten to", req.url);
				next();
			},
			serveStatic(statics.runtime, {
				index: false,
				redirect: false,
				maxAge: statics.maxAge * 1000,
				dotfiles: 'ignore',
				fallthrough: true
			}),
			function(req, res, next) {
				if (/^(get|head)$/i.test(req.method)) {
					next(new HttpError.NotFound("Static file not found"));
				} else {
					next();
				}
			}
		);
	});
}

exports.install = function({mounts, domain}) {
	return rimraf(Path.join(All.opt.statics.runtime, domain)).then(function() {
		return Promise.all(mounts.map(function(mount) {
			return mountPath(mount.from, mount.to);
		}));
	});
};

function mountPath(src, dst) {
	var base = All.opt.statics.runtime;
	var absDst = Path.resolve(Path.join(base, dst));
	if (absDst.startsWith(base) == false) {
		console.error("Cannot mount outside runtime", dst);
		return;
	}

	debug(`Mount ${src} to ${absDst}`);

	return mkdirp(Path.dirname(absDst)).then(function() {
		return fs.unlink(absDst).catch(function(err) {}).then(function() {
			return fs.symlink(src, absDst);
		});
	});
}
