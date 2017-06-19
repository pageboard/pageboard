exports = module.exports = function(opt) {
	return {
		name: 'page',
		service: init
	};
};

function init(All) {
	All.app.get('/.api/page', All.query, function(req, res, next) {
		exports.get(req.query).then(function(page) {
			res.send(page);
		}).catch(next);
	});
	All.app.get('/.api/pages', All.query, function(req, res, next) {
		exports.find(req.query).then(function(pages) {
			res.send(pages);
		}).catch(next);
	});
	All.app.post('/.api/page', All.body, function(req, res, next) {
		exports.add(req.body).then(function(page) {
			res.send(page);
		}).catch(next);
	});
	All.app.put('/.api/page', All.body, function(req, res, next) {
		exports.save(req.body).then(function(page) {
			res.send(page);
		}).catch(next);
	});
	All.app.delete('/.api/page', All.query, function(req, res, next) {
		exports.del(req.query).then(function(page) {
			res.send(page);
		}).catch(next);
	});
}

function QueryPage(domain) {
	var Block = All.api.Block;
	return Block.query()
	.select(Block.jsonColumns)
	.first()
	.eager('[parents(parentsFilter),children(childrenFilter).^]', {
		parentsFilter: query => query.select(Block.jsonColumns)
			.where('block.type', 'site')
			.whereJsonText('block.data:domain', domain),
		childrenFilter: query => query.select(Block.jsonColumns)
	});
}

exports.get = function(data) {
	if (!data.domain) throw new HttpError.BadRequest("Missing domain");
	if (!data.url) throw new HttpError.BadRequest("Missing url");

	return QueryPage(data.domain).where('type', 'page')
	.whereJsonText("block.data:url", data.url)
	.then(function(page) {
		if (!page) {
			return QueryPage(data.domain).where('type', 'notfound');
		} else {
			return page;
		}
	});
};

exports.find = function(data) {
	var Block = All.api.Block;
	return Block.query()
	.select(Block.jsonColumns)
	.whereDomain(data.domain)
	.where('block.type', 'page')
	.whereJsonText('block.data:url', 'LIKE', `${data.url || ''}%`);
};

exports.save = function(changes) {
	// changes.remove, add, update are lists of blocks
	// changes.page is the page id
	// normal blocks belongs to the page
	// standalone blocks follow these rules:
	// - if it is added, it is added to the site, and to the current page as well
	//   (it is not possible to add a standalone block without adding it to the current page)
	// - if it is updated, it is already added to the current page
	//   (a block cannot become standalone, only added blocks can be standalone, so when
	//    the client wants to change a block to become standalone, it is actually a new copy).
	// - if it is removed, it is removed from the current page. The standalone block
	//   will only be removed later by a garbage collector if no longer used.

	return All.api.blockForDomain(data.domain).then(function(Block) {
		return All.objection.transaction(Block);
	}).then(function(Block) {
		var site, page;
		return Block.query().whereJsonText('block.data:domain', changes.domain)
		.first().then(function(inst) {
			if (!inst) throw new HttpError.NotFound("Site not found");
			site = inst;
		}).then(function() {
			console.log(changes);
			return site.$relatedQuery('children').where('block.id', changes.page)
			.first().then(function(inst) {
				if (!inst) throw new HttpError.NotFound("Page not found");
				page = inst;
			});
		}).then(function() {
			return removeChanges(site, page, changes.remove);
		}).then(function() {
			return addChanges(site, page, changes.add);
		}).then(function() {
			return updateChanges(site, page, changes.update);
		});
	});
};

function updateChanges(site, page, updates) {
	// here we just try to patch and let the db decide what was actually possible
	return Promise.all(updates.map(function(child) {
		return site
		.$relatedQuery('children')
		.patch(child)
		.where({
			id: child.id,
			standalone: true
		}).then(function() {
			return page
			.$relatedQuery('children')
			.patch(child)
			.where({
				id: child.id,
				standalone: false
			});
		});
	}));
}

function addChanges(site, page, adds) {
	// when a standalone block is added, it needs to be related to the site and to the page
	// unless it is an orphan standalone block
	var orphans = {};
	adds.forEach(function(block) {
		if (block.orphan) orphans[block.id] = true;
		delete block.orphan;
	});
	return page
	.$relatedQuery('children')
	.insert(adds)
	.then(function(rows) {
		return page
		.$relatedQuery('children')
		.relate(rows.filter(row => !orphans[row.id]).map(row => row._id))
		.then(() => rows);
	}).then(function(rows) {
		var alones = rows
		.filter(row => row.standalone)
		.map(row => row._id);
		if (alones.length) {
			return site
			.$relatedQuery('children')
			.relate(alones);
		}
	});
}

function removeChanges(site, page, removes) {
	var ids = removes.map(obj => obj.id);
	return page.$relatedQuery('children')
	.unrelate()
	.whereIn('id', ids)
	.then(function() {
		// now remove all blocks that are not standalone blocks, trusting db only
		return page
		.$relatedQuery('children')
		.delete()
		.whereIn('id', ids)
		.where('standalone', false);
	});
}

exports.add = function(data) {
	throw new HTTPError.NotImplemented("TODO use save to add page blocks");
};

exports.del = function(data) {
	throw new HTTPError.NotImplemented("TODO use save to delete page blocks");
};

