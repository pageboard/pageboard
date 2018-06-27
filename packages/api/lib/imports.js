var Path = require('path');
var pify = require('util').promisify;
var toSource = require('tosource');

var fs = {
	readFile: pify(require('fs').readFile)
};
var vm = require('vm');
var debug = require('debug')('pageboard:imports');

exports.install = function(site, pkg, All) {
	var elements = pkg.elements;
	var directories = pkg.directories;
	debug("installing", id, elements, directories);
	var id = site ? site.id : null;
	var allDirs = id ? All.opt.directories.concat(directories) : directories;
	var allElts = id ? All.opt.elements.concat(elements) : elements;

	sortPriority(allDirs);
	sortPriority(allElts);

	return Promise.all(allElts.map(function(eltObj) {
		return fs.readFile(eltObj.path);
	})).then(function(bufs) {
		var elts = {};
		var names = [];
		var context = {};
		bufs.forEach(function(buf, i) {
			var path = allElts[i].path;
			context.mount = getMountPath(path, id, allDirs);
			context.path = path;
			loadFromFile(buf, elts, names, context);
		});

		var eltsMap = {};
		names.forEach(function(name) {
			var elt = Object.assign({}, elts[name]); // drop proxy
			eltsMap[name] = elt;
		});
		var Block = All.api.Block.extendSchema(id, eltsMap);
		if (id) {
			pkg.Block = Block;
			pkg.eltsMap = eltsMap;
		} else {
			All.api.Block = Block;
		}
	}).catch(function(err) {
		console.error(err);
		throw err;
	});
};

exports.validate = function(site, pkg) {
	return Promise.resolve().then(function() {
		var eltsMap = pkg.eltsMap;
		var pages = [];
		Object.keys(eltsMap).forEach(function(key) {
			var el = eltsMap[key];
			if (!el.name) el.name = key;
			if (el.group == "page") pages.push(el);
		});
		site.$pages = {};
		return Promise.all(pages.map(function(page) {
			page = eltsMap[page.name] = Object.assign({}, page);
			return bundle(site, pkg, page);
		}));
	}).then(function() {
		Object.values(pkg.eltsMap).forEach(function(elt) {
			if (elt.group != "page" && elt.name != "site") {
				delete elt.stylesheets;
				delete elt.scripts;
			}
		});
		site.constructor = pkg.Block;
		var eltsPages = {};
		Object.keys(site.$pages).forEach(function(name) {
			eltsPages[name] = Object.assign({}, pkg.eltsMap[name]);
			delete eltsPages[name].scripts;
			delete eltsPages[name].stylesheets;
			delete eltsPages[name].resources;
			delete eltsPages[name].render;
			delete eltsPages[name].contents;
		});
		Object.keys(site.$pages).forEach(function(name) {
			site.$pages[name] = {
				source: toSource(Object.assign({}, eltsPages, site.$pages[name]))
			};
		});
		site.$resources = pkg.eltsMap.site.resources;
		delete pkg.eltsMap;
		delete pkg.Block;
	});
};

function sortPriority(list) {
	list.sort(function(a, b) {
		var pa = a.priority;
		var pb = b.priority;
		if (pa == pb) return 0;
		if (pa < pb) return -1;
		else return 1;
	});
}

function bundle(site, pkg, page) {
	var list = listDependencies(site.id, pkg.eltsMap, page);
	list.sort(function(a, b) {
		return (a.priority || 0) - (b.priority || 0);
	});
	var scripts = filter(list, 'scripts');
	var styles = filter(list, 'stylesheets');

	var pageMap = {};
	list.forEach(function(elt) {
		pageMap[elt.name] = elt;
	});
	site.$pages[page.name] = pageMap;

	if (site.data.env == "dev" || !pkg.dir || !site.href) {
		page.scripts = scripts;
		page.stylesheets = styles;
		return Promise.resolve();
	}

	var prefix = page.name == "page" ? "" : `${page.name}-`;

	return Promise.all([
		All.statics.bundle(site, pkg, scripts, `${prefix}scripts.js`),
		All.statics.bundle(site, pkg, styles, `${prefix}styles.css`)
	]).then(function(both) {
		page.scripts = both[0];
		page.stylesheets = both[1];
	});
}

function listDependencies(id, eltsMap, el, list=[], sieve={}) {
	var word;
	if (typeof el == "string") {
		word = el;
		el = eltsMap[word];
		if (!el) {
			var isGroup = false;
			Object.keys(eltsMap).forEach(function(key) {
				var gel = eltsMap[key];
				if (!gel.group) {
					if (!gel.render && (gel.stylesheets || gel.scripts)) {
						listDependencies(id, eltsMap, gel, list, sieve);
					}
					return;
				} else if (gel.group == "page") {
					return;
				}
				if (gel.group.split(" ").indexOf(word) >= 0) {
					isGroup = true;
					listDependencies(id, eltsMap, gel, list, sieve);
				}
			});
			if (!isGroup) console.error("Cannot find element");
		}
	}
	if (!el || sieve[el.name]) return list;
	list.push(el);
	sieve[el.name] = true;
	if (!el.contents) return list;
	var contents = el.contents;
	if (typeof contents == "string") contents = {content: contents};
	Object.keys(contents).forEach(function(key) {
		var val = contents[key];
		var spec = typeof val == "string" ? val : val.spec;
		if (!spec) return;
		spec.split(/\W+/).filter(x => !!x).forEach(function(word) {
			if (word == "text" || word == "page") return;
			if (!sieve[word]) {
				listDependencies(id, eltsMap, word, list, sieve);
			}
		});
	});
	return list;
}

function filter(elements, prop) {
	var map = {};
	var res = [];
	elements.forEach(function(el) {
		var list = el[prop];
		if (!list) return;
		if (typeof list == "string") list = [list];
		var url, prev;
		for (var i=0; i < list.length; i++) {
			url = list[i];
			prev = map[url];
			if (prev) {
				if (el.priority != null) {
					if (prev.priority == null) {
						// move prev url on top of res
						res = res.filter(function(lurl) {
							return lurl != url;
						});
					} else if (prev.priority != el.priority) {
						console.warn(prop, url, "declared in element", el.name, "with priority", el.priority, "is already declared in element", prev.name, "with priority", prev.priority);
						continue;
					} else {
						continue;
					}
				} else {
					continue;
				}
			}
			map[url] = el;
			res.push(url);
		}
	});
	return res;
}

function getMountPath(eltPath, id, directories) {
	var mount = directories.find(function(mount) {
		return eltPath.startsWith(mount.from);
	});
	if (!mount) return;
	var basePath = id ? mount.to.replace(id + "/", "") : mount.to;
	var eltPathname = Path.join(basePath, eltPath.substring(mount.from.length));
	return Path.dirname(eltPathname);
}

function absolutePaths(list, file) {
	if (!list) return list;
	if (typeof list == "string") list = [list];
	return list.map(function(path) {
		if (path.startsWith('/') || /^(http|https|data):/.test(path)) {
			return path;
		}
		if (!file.mount) {
			console.error("Cannot mount", path, "from element defined in", file.path);
			return;
		}
		return Path.join(file.mount, path);
	}).filter(x => !!x);
}

function loadFromFile(buf, elts, names, context) {
	var script = new vm.Script(buf, {
		filename: context.path
	});
	var sandbox = {
		Pageboard: {
			elements: elts
		}
	};
	script.runInNewContext(sandbox, {
		filename: context.path,
		timeout: 1000
	});

	var arrProxy = new ArrProxy(context);
	var elt;
	for (var name in elts) {
		elt = elts[name];
		if (!elt) {
			console.warn("element", name, "is not defined at", context.path);
			continue;
		}

		names.push(name);

		['scripts', 'stylesheets', 'resources'].forEach(function(what) {
			var list = absolutePaths(elt[what], context);
			if (list) elt[what] = list;
			else delete elt[what];
		});

		Object.defineProperty(elts, name, {
			value: new Proxy(elt, new EltProxy(name, context)),
			writable: false,
			enumerable: false,
			configurable: false
		});
	}
}

class EltProxy {
	constructor(name, context) {
		this.name = name;
		this.context = context;
	}
	set(elt, key, val) {
		if (this.name == "user") return false; // changing user is forbidden
		if (key == "scripts" || key == "stylesheets" || key == "resources") {
			val = new Proxy(absolutePaths(val, this.context), new ArrProxy(this.context));
		}
		return Reflect.set(elt, key, val);
	}
}

class ArrProxy {
	constructor(context) {
		this.context = context;
	}
	set(arr, key, val) {
		if (typeof key == "integer" && val != null) {
			val = absolutePaths(val, this.context);
		}
		return Reflect.set(arr, key, val);
	}
	get(arr, key) {
		if (['push', 'unshift'].includes(key)) {
			var context = this.context;
			return function() {
				var args = absolutePaths(Array.from(arguments), context);
				return Array.prototype[key].apply(arr, args);
			};
		}
		return Reflect.get(arr, key);
	}
}

