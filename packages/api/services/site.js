const lodashMerge = require.lazy('lodash.merge');
const {ref, raw} = require('objection');
const {PassThrough} = require('stream');
const {createReadStream, createWriteStream} = require('fs');
const Upgrader = require('../upgrades');

const Path = require('path');

exports = module.exports = function(opt) {
	return {
		name: 'site',
		service: init
	};
};

function init(All) {
	All.app.put('/.api/site', All.auth.lock('webmaster'), function(req, res, next) {
		var data = Object.assign(req.body, {id: req.site.id});
		All.run('site.save', req, data).then(function(site) {
			res.send(site);
		}).catch(next);
	});
}

function QuerySite({trx}, data) {
	/* gets distinct typesin this site as json array
	.select(
		Block.query().from('block AS b')
			.select(raw('array_to_json(array_agg(distinct b.type))'))
			.join('relation as r', 'b._id', 'r.child_id')
			.where('r.parent_id', ref('site._id'))
			.as('types')
	)
	*/
	var Block = All.api.Block;
	var q = Block.query(trx).alias('site')
	.first().throwIfNotFound()
	.where('site.type', 'site').where(function(q) {
		if (data.id) q.orWhere('site.id', data.id);
		if (data.domain) q.orWhereJsonHasAny('site.data:domains', data.domain);
	});
	return q;
}

exports.get = function(req, data) {
	return QuerySite(req, data).select();
};

exports.get.schema = {
	title: 'Get site',
	$action: 'read',
	properties: {
		id: {
			title: 'ID',
			type: 'string',
			format: 'id'
		},
		domain: {
			title: 'Domain',
			type: 'string',
			format: 'hostname'
		}
	},
	anyOf: [{
		required: ['id']
	}, {
		required: ['domain']
	}]
};

exports.search = function({trx}, data) {
	var Block = All.api.Block;
	var q = Block.query(trx).alias('site').select().where('site.type', 'site')
	.joinRelated('children', {alias: 'settings'})
	.where('settings.type', 'settings');
	if (data.grants) q.where(function(builder) {
		data.grants.forEach(function(grant) {
			builder.orWhereJsonSupersetOf('settings.data:grants', [grant]);
		});
	});
	return q.joinRelated('parents', {alias: 'user'})
	.where('user.type', 'user')
	.whereJsonText('user.data:email', data.email)
	.orderBy('site.updated_at', 'site.desc')
	.offset(data.offset)
	.limit(data.limit).then(function(rows) {
		var obj = {
			data: rows,
			offset: data.offset,
			limit: data.limit
		};
		obj.schemas = {
			site: Block.schema('site')
		};
		return obj;
	});
};
exports.search.schema = {
	title: 'Search user sites',
	$action: 'read',
	required: ['email'],
	properties: {
		email: {
			title: 'Email',
			type: 'string',
			format: 'email'
		},
		grants: {
			title: 'Grants',
			type: 'array',
			items: {
				type: 'string',
				format: 'id'
			}
		},
		limit: {
			title: 'Limit',
			type: 'integer',
			minimum: 0,
			maximum: 50,
			default: 10
		},
		offset: {
			title: 'Offset',
			type: 'integer',
			minimum: 0,
			default: 0
		}
	}
};

exports.create = function({trx}, data) {
	return All.run('site.import', {trx}, {
		id: data.id,
		copy: true,
		file: './data/site.json',
		data: Object.assign(data.data || {}, {
			server: All.opt.version
		})
	}).then(function() {
		return All.run('site.get', {trx}, {id: data.id});
	}).then(function(site) {
		return All.run('settings.save', {site, trx}, {
			email: data.email,
			grants: 'webmaster'
		});
	});
};
exports.create.schema = {
	title: 'Create site with default pages',
	$action: 'add',
	required: ['id', 'email'],
	properties: {
		id: {
			title: 'New ID',
			type: 'string',
			format: 'id'
		},
		email: {
			title: 'Email',
			type: 'string',
			format: 'email',
			transform: ['trim', 'toLowerCase']
		},
		data: {
			title: 'Data',
			type: 'object',
			nullable: true
		}
	}
};

exports.add = function(req, data) {
	return QuerySite(req, {id: data.id}).then(function(site) {
		console.info("There is already a site with this id", data.id);
	}).catch(function(err) {
		data.type = 'site';
		data.children = [{
			standalone: true, // this might not be needed
			type: 'page',
			data: {
				title: '404',
				url: '/.well-known/404',
				noindex: true,
				nositemap: true
			}
		}];
		return All.api.Block.query(req.trx).insertGraph(data);
	});
};

exports.add.schema = {
	title: 'Add site',
	$action: 'add',
	required: ['id', 'data'],
	properties: {
		id: {
			title: 'ID',
			type: 'string',
			format: 'id'
		},
		data: {
			title: 'Data',
			type: 'object'
		}
	}
};

exports.save = function(req, data) {
	return exports.get(req, data).then(function(site) {
		lodashMerge(site.data, data.data);
		if (req.site && req.site.href) site.href = req.site.href;
		return All.install(site).then(function(site) {
			var copy = Object.assign({}, data.data);
			if (site.server) copy.server = site.server;
			return site.$query(req.trx).patchObject({
				type: site.type,
				data: copy
			}).then(function() {
				return site;
			});
		});
	});
};
exports.save.schema = {
	title: 'Save site',
	$action: 'save',
	required: ['id', 'data'],
	properties: {
		id: {
			title: 'ID',
			type: 'string',
			format: 'id'
		},
		data: {
			title: 'Data',
			type: 'object',
			default: {}
		}
	}
};

exports.all = function({trx}) {
	return All.api.Block.query(trx).where('type', 'site').select();
};
exports.all.schema = {
	title: 'List all sites',
	$action: 'read'
};

exports.del = function({trx}, data) {
	var Block = All.api.Block;
	var counts = {};
	return Block.query(trx).where('type', 'site')
	.select('_id', raw('recursive_delete(_id, TRUE) AS blocks'))
	.where('id', data.id)
	.first().throwIfNotFound().then(function(row) {
		counts.blocks = row.blocks;
		// no need to remove href thanks to delete cascade on href._parent_id
	}).then(function() {
		return counts;
	});
};
exports.del.schema = {
	title: 'Delete a site',
	$action: 'del',
	required: ['id'],
	properties: {
		id: {
			title: 'ID',
			type: 'string',
			format: 'id'
		}
	}
};

// export all data but files
exports.export = function({trx}, data) {
	var counts = {
		site: 0,
		blocks: 0,
		standalones: 0,
		hrefs: 0,
		settings: 0,
		reservations: 0
	};
	return exports.get({trx}, data).withGraphFetched(`[children(lones)]`).modifiers({
		lones(builder) {
			return builder.select('_id').where('standalone', true).orderByRaw("data->>'url' IS NOT NULL");
		}
	}).then(function(site) {
		var children = site.children;
		delete site.children;
		var out = createWriteStream(Path.resolve(All.opt.cwd, data.file));
		var finished = new Promise(function(resolve, reject) {
			out.resolve = resolve;
			out.reject = reject;
		});
		out.once('finish', out.resolve);
		out.once('error', out.reject);
		counts.site = 1;
		counts.standalones = children.length;
		out.write('{"site": ');
		out.write(toJSON(site));
		// TODO extend to any non-standalone block that is child of user or settings
		// TODO fix calendar so that reservations are made against a user, not against its settings
		out.write(',\n"settings": [');
		return site.$relatedQuery('children', trx).where('block.type', 'settings')
		.select().withGraphFetched('[parents(user) as user]').modifiers({
			user(builder) {
				return builder.select(
					ref('data:email').castText().as('email')
				).where('block.type', 'user');
			}
		}).joinRelated('parents', {alias: 'site'})
		.where('site.type', 'site').then(function(settings) {
			var last = settings.length - 1;
			settings.forEach(function(setting, i) {
				var user = setting.user;
				delete setting.user;
				if (user.length == 0) return;
				user = user[0];
				if (!user.email) return;
				counts.settings++;
				setting._email = user.email;
				out.write(toJSON(setting));
				if (i != last) out.write('\n,');
			});
		}).then(function() {
			out.write(']');
		}).then(function() {
			out.write(',\n"standalones": [');
			var last = children.length - 1;
			var prom = Promise.resolve();
			return children.reduce(function(p, child, i) {
				return p.then(function() {
					return All.api.Block.query(trx)
					.selectWithout('tsv', '_id')
					.first().where('_id', child._id)
					.withGraphFetched('[children(notlones) as children,children(lones) as standalones]')
					.modifiers({
						notlones(builder) {
							return builder.selectWithout('tsv', '_id').where('standalone', false);
						},
						lones(builder) {
							return builder.select('block.id')
							.where('standalone', true)
							.orderByRaw("block.data->>'url' IS NOT NULL ASC");
						}
					}).then(function(lone) {
						if (lone.standalones.length == 0) {
							delete lone.standalones;
						}
						counts.blocks += lone.children.length;
						out.write(toJSON(lone));
						if (i != last) out.write('\n,');
					});
				});
			}, prom);
		}).then(function() {
			out.write('],\n"reservations": [');
		}).then(function() {
			return site.$relatedQuery('children', trx).where('block.type', 'event_reservation')
			.select().withGraphFetched('parents(notsite) as parents').modifiers({
				notsite(builder) {
					return builder.select('block.id', 'block.type')
					.whereIn('block.type', ['settings', 'event_date']);
				}
			}).then(function(reservations) {
				var last = reservations.length - 1;
				reservations.forEach(function(resa, i) {
					counts.reservations++;
					out.write(toJSON(resa));
					if (i != last) out.write('\n,');
				});
			});
		}).then(function() {
			out.write('],\n"hrefs": [');
			return All.api.Href.query(trx).selectWithout('tsv', '_id', '_parent_id')
			.whereSite(site.id).then(function(hrefs) {
				counts.hrefs = hrefs.length;
				var last = hrefs.length - 1;
				hrefs.forEach(function(href, i) {
					out.write(JSON.stringify(href));
					if (i != last) out.write('\n,');
				});
			});
		}).then(function() {
			out.write(']');
		}).then(function() {
			out.end('}');
			return finished;
		});
	}).then(function() {
		return counts;
	});
};
exports.export.schema = {
	title: 'Export site',
	$action: 'read',
	required: ['id', 'file'],
	properties: {
		id: {
			title: 'ID',
			type: 'string',
			format: 'id'
		},
		file: {
			title: 'File path',
			type: 'string'
		}
	}
};

// import all data but files
exports.import = function({trx}, data) {
	var Block = All.api.Block;
	var counts = {
		site: 0,
		blocks: 0,
		standalones: 0,
		settings: 0,
		users: 0,
		hrefs: 0,
		reservations: 0
	};
	var p = Promise.resolve();
	const fstream = createReadStream(Path.resolve(All.opt.cwd, data.file));
	const pstream = new PassThrough({
		objectMode: true,
		highWaterMark: 1
	});
	var site;
	var queues = {};
	var mp = [];
	var upgrader;
	pstream.on('data', function(obj) {
		if (obj.site) {
			if (!obj.site.data) obj.site.data = {};
			var fromVersion = obj.site.data.server;
			Object.assign(obj.site.data, data.data || {});
			upgrader = new Upgrader(Block, {
				copy: data.copy,
				from: fromVersion,
				to: obj.site.data.server
			});
			upgrader.process(obj.site);
			upgrader.finish(obj.site);
			obj.site.id = data.id;
			p = p.then(function() {
				return Block.query(trx).insert(obj.site).returning('*').then(function(siteCopy) {
					counts.site++;
					site = siteCopy;
				});
			});
		} else if (obj.lone) {
			var lone = upgrader.process(obj.lone, site);
			var doneLone;
			queues[lone.id] = new Promise(function(resolve) {
				doneLone = resolve;
			});
			var lonesRefs = [];
			mp.push(p.then(function() {
				var lones = lone.standalones;
				if (!lones) return;
				delete lone.standalones;
				return Promise.all(lones.map(function(rlone) {
					// relate lone to rlone
					var id = upgrader.get(rlone.id);
					if (!id) throw new Error("unknown standalone " + rlone.id);
					return queues[id].then(function(_id) {
						lonesRefs.push({
							"#dbRef": _id
						});
					});
				}));
			}).then(function() {
				lone.children.forEach(function(child) {
					child.parents = [{
						"#dbRef": site._id
					}];
				});
				upgrader.finish(lone);
				lone.children = lone.children.concat(lonesRefs);
				return site.$relatedQuery('children', trx).insertGraph(lone, {
					allowRefs: true
				}).then(function(obj) {
					counts.standalones++;
					counts.blocks += lone.children.length;
					doneLone(obj._id);
				});
			}));
		} else if (obj.href) {
			p = p.then(function() {
				var href = obj.href;
				if (href.pathname) {
					href.pathname = href.pathname.replace(/\/uploads\/[^/]+\//, `/uploads/${site.id}/`);
				}
				counts.hrefs++;
				return site.$relatedQuery('hrefs', trx).insert(href).catch(function(err) {
					console.error(err, href);
					throw err;
				});
			});
		} else if (obj.setting) {
			var setting = upgrader.process(obj.setting, obj.site);
			p = p.then(function() {
				upgrader.finish(setting);
				return Block.query(trx).where('type', 'user')
				.whereJsonText('data:email', setting._email).select('_id')
				.first().throwIfNotFound()
				.catch(function(err) {
					if (err.status != 404) throw err;
					counts.users++;
					return Block.query(trx).insert({
						data: { email: setting._email },
						type: 'user'
					}).returning('_id');
				}).then(function(user) {
					setting.parents = [{'#dbRef': user._id}];
					counts.settings++;
					delete setting._email;
					return site.$relatedQuery('children', trx).insertGraph(setting);
				});
			});
		} else if (obj.reservation) {
			var resa = upgrader.process(obj.reservation, obj.site);
			p = p.then(function() {
				upgrader.finish(resa);
				var parents = resa.parents || [];
				if (parents.length != 2) {
					console.warn("Ignoring reservation", resa);
					return;
				}
				// get settings, date
				return site.$relatedQuery('children', trx)
				.select('_id')
				.whereIn('block.id', parents.map(function(parent) {
					return parent.id;
				})).then(function(parents) {
					resa.parents = parents.map(function(parent) {
						return {"#dbRef": parent._id};
					});
				}).then(function() {
					counts.reservations++;
					return site.$relatedQuery('children', trx).insertGraph(resa, {
						allowRefs: true
					});
				});
			});
		}
		p.catch(function(ex) {
			pstream.emit('error', ex);
		});
	});

	const jstream = require('oboe')(fstream);
	jstream.node('!.site', function(data) {
		pstream.write({site: data});
	});
	jstream.node('!.standalones[*]', function(data) {
		pstream.write({lone: data});
	});
	jstream.node('!.hrefs[*]', function(data) {
		pstream.write({href: data});
	});
	jstream.node('!.settings[*]', function(data) {
		pstream.write({setting: data});
	});
	jstream.node('!.reservations[*]', function(data) {
		pstream.write({reservation: data});
	});
	jstream.on('end', function() {
		pstream.end();
	});
	jstream.on('fail', function(failObj) {
		pstream.emit('error', failObj);
	});

	var q = new Promise(function(resolve, reject) {
		pstream.on('error', function(err) {
			reject(err);
		});
		pstream.on('finish', function() {
			resolve();
		});
	});
	return q.then(function() {
		mp.push(p);
		return Promise.all(mp);
	}).then(function() {
		return counts;
	});
};
exports.import.schema = {
	title: 'Import site',
	$action: 'write',
	required: ['id', 'file'],
	properties: {
		id: {
			title: 'ID',
			type: 'string',
			format: 'id'
		},
		file: {
			title: 'File path',
			type: 'string'
		},
		copy: {
			title: 'Generate new ids',
			type: 'boolean',
			default: true
		},
		data: {
			title: 'Data',
			type: 'object',
			default: {}
		}
	}
};


function toJSON(obj) {
	return JSON.stringify(obj, null, " ");
}

exports.gc = function({trx}) {
	// deletes all blocks that belong to no site
	return trx.raw(`DELETE FROM block
WHERE block.type NOT IN ('site', 'user') AND NOT EXISTS (SELECT c._id FROM block c, relation r, block p
WHERE c._id = block._id AND r.child_id = c._id AND p._id = r.parent_id AND p.type IN ('site', 'user')
GROUP BY c._id HAVING count(*) >= 1)`);
};
