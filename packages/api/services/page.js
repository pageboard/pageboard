var ref = require('objection').ref;
var raw = require('objection').raw;
var URL = require('url');

exports = module.exports = function(opt) {
	return {
		name: 'page',
		service: init
	};
};

function init(All) {
	All.app.get('/.api/page', function(req, res, next) {
		if (All.auth.test(req, 'webmaster') && req.query.develop != "write") {
			res.send({
				item: {
					type: 'write'
				},
				meta: Object.assign({services: req.site.$services}, req.site.$standalones.write),
				site: req.site.data
			});
		} else {
			delete req.query.develop;
			All.run('page.get', req.site, req.query).then(function(page) {
				res.send(page);
			}).catch(next);
		}
	});
	All.app.get('/.api/pages', function(req, res, next) {
		if (All.auth.test(req, 'webmaster')) {
			req.query.drafts = true; // TODO replace by proper permission management
			req.query.type = ['page', 'mail'];
		}
		All.run('page.list', req.site, req.query).then(function(obj) {
			res.send(obj);
		}).catch(next);
	});
	All.app.post('/.api/page', All.auth.restrict('webmaster'), function(req, res, next) {
		All.run('page.add', req.site, req.body).then(function(page) {
			res.send(page);
		}).catch(next);
	});
	All.app.put('/.api/page', All.auth.restrict('webmaster'), function(req, res, next) {
		All.run('page.save', req.site, req.body).then(function(page) {
			res.send(page);
		}).catch(next);
	});
	All.app.delete('/.api/page', All.auth.restrict('webmaster'), function(req, res, next) {
		All.run('page.del', req.site, req.query).then(function(page) {
			res.send(page);
		}).catch(next);
	});

	All.app.get('/robots.txt', All.cache.tag('api'), function(req, res, next) {
		All.run('page.robots', req.site).then(function(txt) {
			res.type('text/plain');
			res.send(txt);
		}).catch(next);
	});

	All.app.get('/.api/sitemap.txt', function(req, res, next) {
		All.run('page.list', req.site, {}).then(function(obj) {
			res.type('text/plain');
			res.send(obj.items.map(page => req.site.href + page.data.url).join('\n'));
		}).catch(next);
	});
}

function QueryPage(site) {
	return site.$relatedQuery('children').alias('page')
	.select()
	.first()
	// eager load children (in which there are standalones)
	// and children of standalones
	.eager(`[
		children(childrenFilter),
		children(standalonesFilter) as standalones .children(childrenFilter)
	]`, {
		childrenFilter: function(query) {
			return query.select().where('page.standalone', false);
		},
		standalonesFilter: function(query) {
			return query.select().where('page.standalone', true);
		}
	});
}

function QueryPageHref(site) {
	var hrefs = site.$model.hrefs;
	return site.$model.query(site.trx).alias('site').where('site._id', site._id)
	.joinRelation('children', {alias: 'page'}).clearSelect()
	.first()
	.select(
		site.$raw(`jsonb_object_agg(
			href.url,
			jsonb_set(href.meta, '{mime}', to_jsonb(href.mime))
		) AS hrefs`)
	)
	.join('relation AS r', {
		'r.parent_id': 'page._id'
	})
	.join('block AS b', {
		'b._id': 'r.child_id'
	})
	.where('b.standalone', false)
	.join('href', function() {
		Object.keys(hrefs).forEach(function(type) {
			this.orOn(function() {
				this.on('b.type', site.$lit(type));
				var list = hrefs[type];
				this.on(function() {
					list.forEach(function(path) {
						this.orOn(ref(`b.data:${path}`).castText(), 'href.url');
					}, this);
				});
			});
		}, this);
	});
}

exports.get = function(site, data) {
	return QueryPage(site).whereIn('page.type', site.$pagetypes)
	.whereJsonText("page.data:url", data.url)
	.select(
		QueryPageHref(site).whereIn('page.type', site.$pagetypes)
		.whereJsonText("page.data:url", data.url).as('hrefs')
	)
	.then(function(page) {
		if (!page) {
			return QueryPage(site).where('page.type', 'notfound').throwIfNotFound()
			.select(
				QueryPageHref(site).where('page.type', 'notfound').as('hrefs')
			);
		} else {
			return page;
		}
	}).then(function(page) {
		page.children = page.children.concat(page.standalones);
		delete page.standalones;
		var links = {};
		var obj = {
			item: page,
			meta: site.$standalones[page.type],
			links: links,
			site: site.data,
			hrefs: page.hrefs
		};
		delete page.hrefs;
		if (page.data.url == null) return obj;

		var pageUrl = page.data.url || data.url;
		return Promise.all([
			getParents(site, pageUrl),
			listPages(site, {
				parent: pageUrl.split('/').slice(0, -1).join('/') || '/',
				type: ['page']
			}).clearSelect().select([
				ref('block.data:url').as('url'),
				ref('block.data:redirect').as('redirect'),
				ref('block.data:title').as('title')
			])
		]).then(function(list) {
			links.up = list[0].map(redUrl);
			var siblings = list[1];
			var position = siblings.findIndex(function(item) {
				return item.url == pageUrl;
			});
			if (position > 0) links.prev = redUrl(siblings[position - 1]);
			if (position < siblings.length - 1) links.next = redUrl(siblings[position + 1]);
			if (siblings.length > 1) {
				links.first = redUrl(siblings[0]);
				links.last = redUrl(siblings[siblings.length - 1]);
			}
			return obj;
		});
	});
};
exports.get.schema = {
	$action: 'read',
	required: ['url'],
	properties: {
		url: {
			type: 'string',
			format: 'pathname'
		}
	},
	additionalProperties: false
};

function redUrl(obj) {
	if (obj.redirect) {
		obj.url = obj.redirect;
	}
	delete obj.redirect;
	return obj;
}

function getParents(site, url) {
	var urlParts = url.split('/');
	var urlParents = ['/'];
	for (var i=1; i < urlParts.length - 1; i++) {
		urlParents.push(urlParts.slice(0, i + 1).join('/'));
	}
	return site.$relatedQuery('children').select([
		ref('block.data:url').as('url'),
		ref('block.data:redirect').as('redirect'),
		ref('block.data:title').as('title')
	])
	.where('block.type', 'page')
	.whereJsonText('block.data:url', 'IN', urlParents)
	.orderByRaw("length(block.data->>'url') DESC");
}

function listPages(site, data) {
	var q = site.$relatedQuery('children')
	.select()
	.omit(['content'])
	.whereIn('block.type', data.type);
	if (!data.drafts) {
		q.whereNotNull(ref('block.data:url'));
	}
	if (data.parent) {
		q.whereJsonText('block.data:url', '~', `^${data.parent}/[^/]+$`)
		.orderBy(ref('block.data:index'));
	} else if (data.url) {
		q.whereJsonText('block.data:url', 'LIKE', `${data.url || ''}%`);
	} else {
		// just return all pages for the sitemap
	}
	return q.orderBy(ref('block.data:url'));
}

exports.search = function(site, data) {
	var text = data.text.split(/\W+/)
	.filter(x => !!x)
	.map(x => x + ':*')
	.join(' <-> ');

	var q = All.api.Block.raw(`SELECT json_build_object(
		'count', count,
		'rows', json_agg(
			json_build_object(
				'id', id,
				'data', json_build_object(
					'title', title,
					'url', url,
					'updated_at', updated_at,
					'headlines', headlines,
					'rank', rank
				)
			)
		)) AS result FROM (
		SELECT
			id, title, url, updated_at, json_agg(DISTINCT headlines) AS headlines, sum(qrank) AS rank,
			count(*) OVER() AS count
		FROM (
			SELECT
				page.id,
				page.data->>'title' AS title,
				page.data->>'url' AS url,
				page.updated_at,
				(SELECT string_agg(heads.value, '<br>') FROM (SELECT DISTINCT trim(value) AS value FROM jsonb_each_text(ts_headline('unaccent', block.content, search.query)) WHERE length(trim(value)) > 0) AS heads) AS headlines,
				ts_rank(block.tsv, search.query) AS qrank
			FROM
				block AS site,
				relation AS rs,
				block,
				relation AS rp,
				block AS page,
				(SELECT to_tsquery('unaccent', ?) AS query) AS search
			WHERE
				site.type = 'site' AND site.id = ?
				AND rs.parent_id = site._id AND block._id = rs.child_id
				AND block.type NOT IN ('site', 'user', 'page', 'query', 'form')
				AND rp.child_id = block._id AND page._id = rp.parent_id
				AND page.type = 'page'
				AND search.query @@ block.tsv
		) AS results
		GROUP BY id, title, url, updated_at ORDER BY rank DESC OFFSET ? LIMIT ?
	) AS foo GROUP BY count`, [
		text,
		site.id,
		data.offset,
		data.limit
	]);
	return q.then(function(results) {
		var obj = {
			offset: data.offset,
			limit: data.limit,
			total: 0
		};
		if (results.rowCount == 0) {
			obj.items = [];
		} else {
			var result = results.rows[0].result;
			obj.items = result.rows;
			obj.total = result.count;
		}
		return obj;
	});
};

exports.search.schema = {
	title: 'Search pages',
	$action: 'read',
	required: ['text'],
	properties: {
		text: {
			title: 'Search text',
			type: 'string',
			format: 'singleline'
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
	},
	additionalProperties: false
};
exports.search.external = true;

exports.list = function(site, data) {
	return listPages(site, data).then(function(pages) {
		return {
			items: pages,
			item: {
				type: 'sitemap'
			},
			meta: site.$standalones.sitemap
		};
	});
};
exports.list.schema = {
	title: 'Site map',
	$action: 'read',
	properties: {
		parent: {
			type: 'string',
			format: 'id'
		},
		url: {
			type: 'string',
			format: 'pathname'
		},
		drafts: {
			title: 'Show pages that have no url',
			type: 'boolean',
			default: false
		},
		type: {
			type: 'array',
			items: {
				type: 'string',
				format: 'id'
			},
			default: ['page']
		}
	},
	additionalProperties: false
};
exports.list.external = true;

exports.save = function(site, changes) {
	changes = Object.assign({
		// blocks removed from their standalone parent (grouped by parent)
		unrelate: {},
		// non-standalone blocks unrelated from site and deleted
		remove: [],
		// any block added and related to site
		add: [],
		// block does not change parent
		update: [],
		// block add to a new standalone parent (grouped by parent)
		relate: {}
	}, changes);

	var pages = {
		add: changes.add.filter(b => b.type == "page"),
		update: changes.update.filter(b => b.type == "page")
	};
	pages.all = pages.add.concat(pages.update);

	changes.add.forEach(function(b) {
		stripHostname(site, b);
	});
	changes.update.forEach(function(b) {
		stripHostname(site, b);
	});
	// this also effectively prevents removing a page and adding a new page
	// with the same url as the one removed
	var allUrl = {};
	var returning = {};
	return site.$relatedQuery('children')
	.select('block.id', ref('block.data:url').as('url'))
	.whereIn('block.type', site.$pagetypes)
	.whereNotNull(ref('block.data:url')).then(function(dbPages) {
		pages.all.forEach(function(page) {
			if (!page.data.url || page.data.url.startsWith('/$/')) {
				delete page.data.url;
			} else if (allUrl[page.data.url]) {
				throw new HttpError.BadRequest("Two pages with same url");
			} else {
				if (!page.id) throw new HttpError.BadRequest("Page without id");
				allUrl[page.data.url] = page.id;
			}
		});
		dbPages.forEach(function(dbPage) {
			var id = allUrl[dbPage.url];
			if (id != null && dbPage.id != id) {
				throw new HttpError.BadRequest("Page url already exists");
			}
		});
	}).then(function() {
		// FIXME use site.$model.hrefs to track the blocks with href when saving,
		// and check all new/changed href have matching row in href table
		return applyUnrelate(site, changes.unrelate).then(function() {
			return applyRemove(site, changes.remove);
		}).then(function() {
			return applyAdd(site, changes.add);
		}).then(function() {
			return applyUpdate(site, changes.update);
		}).then(function(list) {
			returning.update = list;
			return applyRelate(site, changes.relate);
		});
	}).then(function(parts) {
		return Promise.all(pages.update.map(function(child) {
			if (!child.data.url) return;
			return All.href.save(site, {
				url: child.data.url,
				title: child.data.title
			}).catch(function(err) {
				if (err.statusCode == 404) return All.href.add(site, {
					url: child.data.url
				}).catch(function(err) {
					console.error(err);
				});
				else console.error(err);
			});
		}));
	}).then(function() {
		return Promise.all(pages.add.map(function(child) {
			if (!child.data.url) return;
			// problem: added pages are not saved here
			return All.href.add(site, {
				url: child.data.url
			}).catch(function(err) {
				console.error(err);
			});
		}));
	}).then(function() {
		return returning;
	});
};
exports.save.schema = {
	$action: 'save',
	properties: {
		add: {
			type: 'array',
			items: {
				type: 'object'
			}
		},
		update: {
			type: 'array',
			items: {
				type: 'object'
			}
		},
		remove: {
			type: 'array',
			items: {
				type: 'string',
				format: 'id'
			}
		},
		relate: {
			type: 'object'
		},
		unrelate: {
			type: 'object'
		}
	},
	additionalProperties: false
};

function stripHostname(site, block) {
	var url = block.data && block.data.url; // FIXME use site.$model.hrefs
	if (url) {
		var objUrl = URL.parse(url);
		if (objUrl.hostname == site.hostname) {
			block.data.url = objUrl.path;
		}
	}
}

function applyUnrelate(site, obj) {
	return Promise.all(Object.keys(obj).map(function(parentId) {
		return site.$relatedQuery('children').where('block.id', parentId)
		.first().throwIfNotFound().then(function(parent) {
			return parent.$relatedQuery('children', site.trx)
			.unrelate()
			.whereIn('block.id', obj[parentId]);
		});
	}));
}

function applyRemove(site, list) {
	if (!list.length) return;
	return site.$relatedQuery('children').delete()
	.whereIn('block.id', list).whereNot('standalone', true);
}

function applyAdd(site, list) {
	if (!list.length) return;
	// this relates site to inserted children
	return site.$relatedQuery('children').insert(list);
}

function applyUpdate(site, list) {
	return Promise.all(list.map(function(block) {
		if (site.$pagetypes.includes(block.type)) {
			return updatePage(site, block);
		} else {
			// simpler path
			return site.$relatedQuery('children')
			.where('block.id', block.id)
			.where(raw("date_trunc('milliseconds', block.updated_at)"), block.updated_at)
			.patch(block)
			.returning('id, updated_at')
			.first()
			.then(function(part) {
				if (!part) throw new HttpError.Conflict(`Please refresh page before saving`);
				return part;
			});
		}
	}));
}

function updatePage(site, page) {
	return site.$relatedQuery('children').where('block.id', page.id)
	.whereIn('block.type', site.$pagetypes)
	.select(ref('block.data:url').as('url')).first().throwIfNotFound().then(function(dbPage) {
		var oldUrl = dbPage.url;
		var newUrl = page.data.url;
		if (oldUrl == newUrl) return dbPage;
		var hrefs = site.$model.hrefs;
		// page.data.url is not a href input, see also page element.
		return Promise.all(Object.keys(hrefs).map(function(type) {
			return Promise.all(hrefs[type].map(function(key) {
				key = 'block.data:' + key;
				var field = ref(key).castText();
				var args = field.toRawArgs();
				return site.$relatedQuery('children').where('block.type', type)
				.where(function() {
					this.where(field, 'LIKE', `${oldUrl}/%`)
					.orWhere(field, oldUrl);
				})
				.patch({
					[key]: raw(`overlay(${args[0]} placing ? from 1 for ${oldUrl.length})`, args[1], newUrl)
				}).skipUndefined();
			}));
		})).then(function() {
			var Href = All.api.Href;
			return Href.query(site.trx).where('_parent_id', site._id)
			.where('type', 'link')
			.where(function() {
				this.where('url', 'LIKE', `${oldUrl}/%`)
				.orWhere('url', oldUrl);
			}).delete();
		}).then(function() {
			return dbPage;
		});
	}).then(function(dbPage) {
		return site.$relatedQuery('children').where('block.id', page.id)
		.whereIn('block.type', site.$pagetypes)
		.where(raw("date_trunc('milliseconds', block.updated_at)"), page.updated_at)
		.patch(page)
		.returning('id, updated_at')
		.first()
		.then(function(part) {
			if (!part) throw new HttpError.Conflict(`Please refresh page before saving`);
			return part;
		});
	}).catch(function(err) {
		console.error("cannot updatePage", err);
		throw err;
	});
}

function applyRelate(site, obj) {
	return Promise.all(Object.keys(obj).map(function(parentId) {
		return site.$relatedQuery('children').where('block.id', parentId)
		.first().throwIfNotFound().then(function(parent) {
			return site.$relatedQuery('children')
			.whereIn('block.id', obj[parentId]).then(function(ids) {
				return parent.$relatedQuery('children', site.trx).relate(ids);
			});
		});
	}));
}

exports.add = function(site, data) {
	var emptyPage = {};
	return site.prototype.$beforeInsert.call(emptyPage).then(function() {
		return exports.save(site, {
			add: [{
				id: emptyPage.id,
				type: 'page',
				data: data.data
			}]
		});
	});
};
exports.add.schema = {
	$action: 'add',
	properties: {
		data: {
			type: 'object'
		}
	},
	additionalProperties: false
};

exports.del = function(site, data) {
	// TODO deleting a page should be done in TWO steps
	// 1) data.url = null -> the page becomes only accessible through admin
	// 2) actual deletion
	// consequences:
	// - if there are links starting or equal to that page url, it's not possible
	// to delete that url
	// - sitemap needs a specific zone that displays pages that have no url
	// - deleting a page from that zone actually deletes the page
	// - moving a page to that zone removes the url of the page (when saving,
	// and when possible)
	throw new HttpError.NotImplemented("TODO use save to delete page blocks");
};

exports.robots = function(site) {
	var lines = ["User-agent: *"];
	if (site.data.env == "production") {
		lines.push("Allow : /");
		lines.push(`Sitemap: ${site.href}/.api/sitemap.txt`);
	} else {
		lines.push("Disallow: /");
	}
	return Promise.resolve(lines.join('\n'));
};

