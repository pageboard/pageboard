var sharpie = require('sharpie');
var sharp = sharpie.sharp;
var pify = require('util').promisify;
var fs = {
	rename: pify(require('fs').rename)
};

var BufferList = require('bl');
var DataUri = require('datauri');

exports = module.exports = function(opt) {
	sharp.simd(true);
	if (!opt.image) opt.image = {};
	if (!opt.image.dir) opt.image.dir = ".image";
	if (!opt.image.converter) opt.image.converter = 'convert';

	if (!opt.image.signs) opt.image.signs = {
		assignment: '-',
		separator: '_'
	};

	return {
		name: 'image',
		file: initFile,
		service: initService,
		priority: 10
	};
};

function initFile(All) {
	var opt = All.opt;
	var uploadDir = opt.upload && opt.upload.dir;
	if (uploadDir) {
		uploadDir = "." + uploadDir;
		console.info("Uploaded images resizable by upload at", "/" + uploadDir);
		All.app.get(`:url(/${uploadDir}/*)`, function(req, res, next) {
			if (!req.query.rs && !req.query.ex && !req.query.q) next('route');
			else next();
		}, sharpie(All.opt.image));
	}
	return All.utils.which(opt.image.converter).catch(function() {}).then(function(path) {
		if (path) {
			opt.image.converterPath = path;
			console.info("Using image converter", path);
		} else {
			console.warn("Missing image converter", opt.image.converter, "favicon disabled");
		}
	});
}

function initService(All) {
	console.info(`Remote images resizable by proxy at /.api/image`);
	All.app.get('/.api/image', sharpie(All.opt.image));
}

exports.favicon = function(path) {
	if (!All.opt.image.converterPath) throw new HttpError.NotFound("Cannot convert favicons");
	return All.utils.spawn('convert', [
		"-background", "none",
		path,
		"-define", "icon:auto-resize=64,32,16",
		"ico:-"
	], {
		cwd: All.opt.statics.runtime,
		timeout: 10 * 1000,
		env: {}
	});
};

function request(url) {
	var obj = require('url').parse(url);
	var agent;
	if (obj.protocol == "http:") agent = require('http');
	else if (obj.protocol == "https:") agent = require('https');
	var stream = new require('stream').PassThrough();
	agent.get(url).on('response', function(res) {
		res.pipe(stream);
	});
	return stream;
}

exports.thumbnail = function(url) {
	var pipeline;
	if (url.startsWith('file://')) {
		pipeline = sharp(url.substring(7));
	} else {
		pipeline = sharp();
		request(url).pipe(pipeline);
	}
	return pipeline
	.resize(null, 64)
	.max()
	.background('white')
	.flatten()
	.toFormat('jpeg', {
		quality: 65
	})
	.toBuffer().then(function(buf) {
		var dtu = new DataUri();
		dtu.format('.jpeg', buf);
		return dtu.content;
	});
};

exports.upload = function(file) {
	var mime = file.mimetype;
	if (!mime) {
		console.warn("image.upload cannot inspect file without mime type", file);
		return;
	}
	if (!mime.startsWith('image/')) return;
	if (mime.startsWith('image/svg')) return;
	var format = mime.split('/').pop();
	if (!sharp.format[format]) {
		console.warn("image.upload cannot process", mime);
		return;
	}
	var dst = file.path + ".tmp";
	var pipeline = sharp(file.path);
	return pipeline.metadata().then(function(meta) {
		return pipeline.toFormat(meta.format, {quality:93}).toFile(dst);
	}).then(function() {
		return fs.rename(dst, file.path);
	});
};
