var ip = require('ip');

function BlockTree(start, end, reason) {
	this.block = { start: start, end: end, reason: reason };
	this.max = end;
	this.depth = 1;
	this.left = null;
	this.right = null;
}

BlockTree.prototype.balance = function() {
	var ldepth = this.left ? this.left.depth : 0;
	var rdepth = this.right ? this.right.depth : 0;

	if (ldepth > rdepth + 1) {
		var lldepth = this.left.left ? this.left.left.depth : 0;
		var lrdepth = this.left.right ? this.left.right.depth : 0;
		if (lldepth < lrdepth) this.left.rotateRR();
		this.rotateLL();
	} else if (ldepth + 1 < rdepth) {
		var rrdepth = this.right.right ? this.right.right.depth : 0;
		var rldepth = this.right.left ? this.right.left.depth : 0;
		if (rldepth > rrdepth) this.right.rotateLL();
		this.rotateRR();
	}
}

BlockTree.prototype.rotateLL = function() {
	var _block = this.block;
	var _right = this.right;

	this.block = this.left.block;
	this.right = this.left;
	this.left = this.left.left;

	this.right.left = this.right.right;
	this.right.right = _right;
	this.right.block = _block;

	this.right.update();
	this.update();
};

BlockTree.prototype.rotateRR = function() {
	var _block = this.block;
	var _left = this.left;

	this.block = this.right.block;
	this.end = this.right.end;
	this.left = this.right;
	this.right = this.right.right;

	this.left.right = this.left.left;
	this.left.left = _left;
	this.left.block = _block;

	this.left.update();
	this.update();
};

BlockTree.prototype.update = function() {
	this.depth = 1;
	if (this.left) this.depth = this.left.depth + 1;
	if (this.right && this.depth <= this.right.depth) this.depth = this.right.depth + 1;
	this.max = Math.max(this.block.end, this.left ? this.left.max : 0, this.right ? this.right.max : 0);
};

BlockTree.prototype.add = function(start, end, reason)  {
	var d = start - this.block.start;
	var update = false;

	if (d == 0 && this.block.end < end) {
		this.block.end = end;
		this.block.reason = reason;
		update = true;
	} else if (d < 0) {
		if (this.left) {
			update = this.left.add(start, end, reason);
			if (update) this.balance();
		} else {
			this.left = new BlockTree(start, end, reason);
			update = true;
		}
	} else if (d > 0) {
		if (this.right) {
			update = this.right.add(start, end, reason);
			if (update) this.balance();
		} else {
			this.right = new BlockTree(start, end, reason);
			update = true;
		}
	}

	if (update) this.update();
	return update;
};

BlockTree.prototype.search = function(addr) {
	var node = this;
	while (node && !(addr >= node.block.start && addr <= node.block.end)) {
		if (node.left && node.left.max >= addr) node = node.left;
		else node = node.right;
	}
	return node ? node.block : null;
}

module.exports = function(blocklist) {
	var tree = null;
	var that = {};

	that.add = function(start, end, reason) {
		if (!start) return;
		if (typeof start === 'object') {
			end = start.end;
			reason = start.reason;
			start = start.start;
		}

		if (typeof start !== 'number') start = ip.toLong(start);

		if (!end) end = start;
		if (typeof end !== 'number') end = ip.toLong(end);

		if (start < 0 || end > 4294967295 || end < start) throw new Error("Invalid block range");

		if (tree) tree.add(start, end, reason);
		else tree = new BlockTree(start, end, reason);
	}

	that.search = function(addr) {
		if (!tree) return null;
		if (typeof addr !== 'number') addr = ip.toLong(addr);
		return tree.search(addr);
	}

	if (Array.isArray(blocklist)) {
		blocklist.forEach(function(block) {
			that.add(block);
		});
	}

	return that;
};
