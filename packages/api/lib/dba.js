var schedule = require('node-schedule');

exports.migrate = function(knex, dirs) {
	return Promise.all(dirs.map(function(dir) {
		console.info(` ${dir}`);
		return knex.migrate.latest({
			directory: dir
		}).spread(function(batchNo, list) {
			if (list.length) return list;
			return "No migrations run in this directory";
		});
	}));
};

exports.seed = function(knex, dirs) {
	return Promise.all(dirs.map(function(dir) {
		console.info(` ${dir}`);
		return knex.seed.run({
			directory: dir
		}).spread(function(list) {
			if (list.length) console.log(" ", list.join("\n "));
			else console.log("No seed files in", dir);
		});
	}));
};

exports.dump = function(conn, opt) {
	var stamp = (new Date).toISOString().split('.')[0].replace(/[-:]/g, '');
	var file = Path.join(opt.database.dump.dir, `${opt.name}-${stamp}.dump`);
	return exec(`pg_dump --format=custom --file=${file} --username=${conn.user} ${conn.database}`, {}).then(function() {
		return file;
	});
};

exports.knexConfig = function(config) {
	if (!process.env.HOME) process.env.HOME = require('passwd-user').sync(process.getuid()).homedir;
	var dbOpts = Object.assign({}, {
		url: `postgres://localhost/${opt.name}`
	}, config.database);
	delete dbOpts.dump;
	var parsed = require('url').parse(dbOpts.url, true);
	delete dbOpts.url;
	var conn = {};
	var obj = { connection: conn };
	if (parsed.host) conn.host = parsed.host;
	if (parsed.pathname) conn.database = parsed.pathname.substring(1);
	if (parsed.auth) {
		var auth = parsed.auth.split(':');
		conn.user = auth[0];
		if (auth.length > 1) conn.password = auth[1];
	}
	if (parsed.protocol) obj.client = parsed.protocol.slice(0, -1);
	if (dbOpts.client) {
		obj.client = dbOpts.client;
		delete dbOpts.client;
	}
	obj.debug = require('debug').enabled('pageboard:sql');
	if (dbOpts.debug) {
		obj.debug = dbOpts.debug;
		delete dbOpts.debug;
	}
	Object.assign(conn, dbOpts);
	return obj;
};

var gcJob;
exports.gc = function(All) {
	var opts = All.opt.gc;
	if (!opts) opts = All.opt.gc = {};
	var blockDays = parseInt(opts.block);
	if (isNaN(blockDays)) blockDays = 1;
	var hrefDays = parseInt(opts.href);
	if (isNaN(hrefDays)) hrefDays = 7;
	opts.block = blockDays;
	opts.href = hrefDays;

	var interval = Math.max(Math.min(blockDays, hrefDays), 1) * 24 * 60 * 60 * 1000;
	var jump = gcJob == null;
	gcJob = schedule.scheduleJob(new Date(Date.now() + interval), exports.gc.bind(null, All));
	if (jump) return;

	return Promise.all([
		All.block.gc(blockDays),
		All.href.gc(hrefDays)
	]).then(function([blockResult, hrefResult]) {
		if (blockResult.length) {
			console.info(`gc: ${blockResult.length} blocks since ${blockDays} days`);
		}
		if (hrefResult.length) {
			console.info(`gc: ${hrefResult.length} hrefs since ${hrefDays} days`);
		}
		return Promise.all(hrefResult.map(function(obj) {
			if (obj.type == "link") return Promise.resolve();
			return All.upload.gc(obj.site, obj.pathname).catch(function(ex) {
				console.error("gc error", obj.id, obj.url, ex);
			});
		}));
	});
};