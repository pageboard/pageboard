const Path = require('path');
const toSource = require('tosource');

const fs = require('fs').promises;
const vm = require('vm');
const debug = require('debug')('pageboard:imports');

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
		var groups = {};
		var bundles = [];
		names.forEach(function(name) {
			var el = Object.assign({}, elts[name]); // drop proxy
			el.name = name;
			eltsMap[name] = el;
			var isPage = false;
			if (el.group) el.group.split(/\s+/).forEach(function(gn) {
				if (gn == "page") isPage = true;
				var group = groups[gn];
				if (!group) group = groups[gn] = [];
				if (!group.includes(name)) group.push(name);
			});
			if (isPage) el.standalone = el.bundle = true;
			if (el.bundle) bundles.push(el);
		});

		var Block = All.api.Block.extendSchema(id, eltsMap);
		if (id) {
			pkg.Block = Block;
			pkg.eltsMap = eltsMap;
			pkg.groups = groups;
			site.$pages = groups.page;
			site.$bundles = {};
			site.constructor = Block; // gni ?
		} else {
			All.api.Block = Block;
		}
		return bundles;
	}).catch(function(err) {
		console.error(err);
		throw err;
	});
};

exports.validate = function(site, pkg, bundles) {
	var eltsMap = pkg.eltsMap;
	return Promise.all(bundles.map(function(el) {
		el = eltsMap[el.name] = Object.assign({}, el);
		return bundle(site, pkg, el);
	})).then(function() {
		return bundleSource(site, pkg, '', 'services', All.services).then(function(path) {
			site.$services = path;
		});
	}).then(function() {
		site.$scripts = pkg.eltsMap.site.scripts;
		site.$resources = pkg.eltsMap.site.resources;
		site.$stylesheets = pkg.eltsMap.site.stylesheets;
		delete pkg.eltsMap;
		delete pkg.Block;
	});
};

function sortPriority(list) {
	list.sort(function(a, b) {
		var pa = a.priority;
		var pb = b.priority;
		if (pa == pb) {
			if (a.path && b.path) return Path.basename(a.path).localeCompare(Path.basename(b.path));
			else return 0;
		}
		if (pa < pb) return -1;
		else return 1;
	});
}

function bundle(site, pkg, rootEl) {
	var list = listDependencies(pkg, rootEl.group, rootEl);
	list.sort(function(a, b) {
		return (a.priority || 0) - (b.priority || 0);
	});
	var scripts = sortElements(list, 'scripts');
	var styles = sortElements(list, 'stylesheets');
	var prefix = `${rootEl.name}-`;

	var eltsMap = {};
	list.forEach(function(elt) {
		if (!elt.standalone) {
			elt = Object.assign({}, elt);
			delete elt.scripts;
			delete elt.stylesheets;
		}
		eltsMap[elt.name] = elt;
	});
	var metaEl = site.$bundles[rootEl.name] = {
		group: rootEl.group
	};

	var p;

	if (site.data.env == "dev" || !pkg.dir || !site.href) {
		p = Promise.resolve([
			scripts,
			styles
		]);
	} else {
		p = Promise.all([
			All.statics.bundle(site, pkg, scripts, `${prefix}scripts.js`),
			All.statics.bundle(site, pkg, styles, `${prefix}styles.css`)
		]);
	}
	return p.then(function([scripts, styles]) {
		rootEl.scripts = scripts;
		rootEl.stylesheets = styles;

		return bundleSource(site, pkg, prefix, 'elements', eltsMap).then(function(path) {
			metaEl.bundle = path;
			metaEl.scripts = rootEl.group != "page" ? rootEl.scripts : [];
			metaEl.stylesheets = rootEl.group != "page" ? rootEl.stylesheets : [];
			metaEl.resources = rootEl.resources;
		});
	});
}

function bundleSource(site, pkg, prefix, name, obj) {
	var filename = `${prefix}${name}.js`;
	var version = site.data.version;
	if (version == null) version = site.branch;
	var fileurl = `/.files/${version}/_${filename}`;
	var fileruntime = All.statics.resolve(site.id, fileurl);
	var str = `Pageboard.${name} = Object.assign(Pageboard.${name} || {}, ${toSource(obj)});`;
	return fs.writeFile(fileruntime, str).then(function() {
		return All.statics.bundle(site, pkg, [fileurl], filename);
	}).then(function(paths) {
		return paths[0];
	});
}

function listDependencies(pkg, rootGroup, el, list=[], gDone={}, eDone={}) {
	var word;
	var elts = pkg.eltsMap;
	var group;
	if (typeof el == "string") {
		word = el;
		el = elts[word];
		group = pkg.groups[word];
		if (group) {
			if (!gDone[word]) {
				gDone[word] = true;
				group.forEach((name) => {
					listDependencies(pkg, rootGroup, elts[name], list, gDone, eDone);
				});
			}
		} else if (!el) {
			console.error(`'${word}' is not an element nor a group`);
		}
	}
	if (!el || eDone[el.name]) return list;
	list.push(el);
	eDone[el.name] = true; // FIXME this might be a group name, and sometimes we actually want
	// to iterate over group names
	var contents = All.api.Block.normalizeContents(el.contents);
	if (!contents) return list;
	contents.forEach(function(content) {
		if (!content.nodes) return;
		content.nodes.split(/\W+/).filter(x => !!x).forEach(function(word) {
			if (word == rootGroup) {
				console.warn("contents contains root group", rootGroup, el.name, contents);
				return;
			}
			if (word == "text") return;
			if (eDone[word] && (!pkg.groups[word] || gDone[word])) return;
			listDependencies(pkg, rootGroup, word, list, gDone, eDone);
		});
	});
	return list;
}

function sortElements(elements, prop) {
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
	if (!list) return [];
	if (typeof list == "string") list = [list];
	return list.map(function(path) {
		if (path == null) {
			console.warn("null path in", file);
			return;
		}
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
		exports: new Proxy(elts, new MapProxy(context))
	};
	// let's keep compatibility for now
	sandbox.Pageboard = {
		elements: sandbox.exports
	};
	script.runInNewContext(sandbox, {
		filename: context.path,
		timeout: 1000
	});

	ArrProxy.create(context);
	var elt;
	for (var name in elts) {
		elt = elts[name];
		if (!elt) {
			console.warn("element", name, "is not defined at", context.path);
			continue;
		}

		names.push(name);

		['scripts', 'stylesheets', 'resources'].forEach(function(what) {
			elt[what] = new Proxy(absolutePaths(elt[what], context), new ArrProxy(context));
		});

		Object.defineProperty(elts, name, {
			value: new Proxy(elt, new EltProxy(name, context)),
			writable: false,
			enumerable: false,
			configurable: false
		});
	}
}

class MapProxy {
	constructor(context) {
		this.context = context;
	}
	set(obj, key, val) {
		if (obj.hasOwnProperty(key)) {
			if (key == "user" || key == "priv") {
				console.error(`Modifying ${key} element is not allowed`);
				return false;
			}
			console.error("Please avoid setting", key, "in", this.context.path, " - using Object.assign instead");
			Object.assign(obj[key], val);
			return false;
		}
		return Reflect.set(obj, key, val);
	}
}

class EltProxy {
	constructor(name, context) {
		this.name = name;
		this.context = context;
	}
	set(elt, key, val) {
		if (this.name == "user" || this.name == "priv") {
			console.error(`Modifying ${this.name} element properties is not allowed`);
			return false;
		}
		if (key == "scripts" || key == "stylesheets" || key == "resources") {
			val = new Proxy(absolutePaths(val, this.context), new ArrProxy(this.context));
		}
		return Reflect.set(elt, key, val);
	}
}

class ArrProxy {
	static create(context) {
		return new this(context);
	}
	constructor(context) {
		this.context = context;
	}
	set(arr, key, val) {
		if (typeof key == "number" && val != null) {
			val = absolutePaths(val, this.context);
			if (val.length == 1) val = val[0];
			else throw new Error(`Cannot set ${this.context}.${key} with ${val}`);
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

