#!/usr/bin/env node

const {Readable} = require('stream');
const logger = new (require('./lib/logger'))();

var pkgOpt = {};
if (process.env.APPNAME) pkgOpt.name = process.env.APPNAME;

if (process.argv.length > 2) {
	var thenData = false;
	for (var i=2; i < process.argv.length; i++) {
		if (thenData) process.argv[i] = '--data.' + process.argv[i];
		if (process.argv[i].startsWith('--') == false) thenData = true;
	}
}

var pageboard = require(__dirname);

var config = pageboard.config(pkgOpt);
var title = `${config.name} ${config.version}`;
process.title = title;

console.info(title);

pageboard.init(config).then(function(All) {
	if (All.opt._.length > 1) {
		console.error("Cannot process arguments", All.opt._);
		process.exit(1);
	}
	if (All.opt._.length != 1) {
		logger.flush(true);
		return pageboard.start(All);
	}

	var command = All.opt._[0];
	var args = [command];
	return Promise.resolve().then(function() {
		if (config.data !== undefined && typeof config.data.data == "string") {
			try {
				config.data.data = JSON.parse(config.data.data);
			} catch(ex) {
				console.error(ex);
			}
		}
		if (All.opt.site) {
			return All.site.get({id: All.opt.site}).select('_id').then(function(site) {
				return All.install(site).then(function(site) {
					args.push(site);
					if (config.data !== undefined) args.push(config.data);
				});
			});
		} else {
			if (config.data !== undefined) args.push(config.data);
		}
	}).then(function() {
		return All.run.apply(All, args).catch(function(err) {
			console.error(err);
			process.exit(1);
		});
	}).then(function(results) {
		logger.clear(true);
		if (results instanceof Readable) {
			results.pipe(process.stdout);
			results.once('end', function() {
				results.unpipe(process.stdout);
				process.exit();
			});
		} else {
			console.log(JSON.stringify(results, null, ' '));
			process.exit();
		}
	});
}).catch(function(err) {
	console.error(err);
	process.exit(1);
});


