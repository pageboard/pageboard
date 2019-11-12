module.exports = class Upgrader {
	constructor(Block, opts={}) {
		this.copy = !!opts.copy;
		this.Block = Block;
		this.idMap = {};
		if (this.from != this.to && this.from && this.to) {
			try {
				this.module = require(`from-${this.from}-to-${this.to}`);
			} catch(ex) {
				if (ex.code != "MODULE_NOT_FOUND") {
					throw ex;
				}
			}
		}
	}
	get(id) {
		if (this.copy) return this.idMap[id];
		else return id;
	}
	process(block, parent) {
		if (this.copy) {
			var old = block.id;
			block.id = this.idMap[old] = this.Block.genIdSync();
			if (block.parents) block.parents.forEach((parent) => {
				console.log("reattributing parent", parent.id);
				parent.id = this.idMap[parent.id];
				console.log("to", parent.id);
			});
			if (block.type == "site") delete block.data.domains;
		}
		if (block.children) block.children = block.children.map((child) => {
			return this.process(child, block);
		});
		var mod = this.module;
		if (!mod) return block;
		try {
			if (mod.any) mod.any.call(this, block);
			if (mod[block.type]) block = mod[block.type].call(this, block, parent) || block;
		} catch(ex) {
			console.error(ex.message);
			console.error(block);
			throw new Error("Upgrader error");
		}
		return block;
	}
	finish(block) {
		if (this.copy) {
			if (block.children) block.children.forEach((child) => {
				this.finish(child);
			});
			this.copyContent(block);
			this.copyLock(block);
		}
	}
	copyContent(block) {
		if (!block.content) return;
		if (typeof block.content != "object") {
			console.error(block);
			throw new Error("content not object");
		}
		Object.entries(block.content).forEach(([key,str]) => {
			if (!str) return;
			var bad = false;
			block.content[key] = str.replace(/block-id="(\w+)"/g, (match, id, pos, str) => {
				var cid = this.idMap[id];
				if (cid) return cid;
				console.warn(`Cannot replace id: '${id}' in content
					${str.substring(pos - 5, pos + 35)}`);
				bad = true;
				return "X";
			});
			if (bad) {
				block.content[key] = str.replace(/<\w+ block-id="X"><\/\w+>/g, '');
			}
		});
	}
	copyLock(block) {
		var locks = block.lock && block.lock.read;
		if (!locks) return;
		locks.forEach((item, i) => {
			item = item.split('-');
			if (item.length != 2) return;
			var id = this.idMap[item[1]];
			if (id) item[1] = id;
			locks[i] = item.join('-');
		});
	}
};

