var noop = function() {}

module.exports = function(storage) {
  var that = {};
  var mem = []

  that.read = function(index, range, cb) {
    if (typeof range === 'function') return that.read(index, null, range);

    var offset = (range && range.offset) || 0;
    var length = range && range.length;

    if (mem[index]) return cb(null, range ? mem[index].slice(offset, offset+(length || mem[index].length)) : mem[index]);
    storage.read(index, range, cb);
  };

  that.write = function(index, buf, cb) {
    if (!cb) cb = noop
    mem[index] = buf;
    storage.write(index, buf, function(err) {
      mem[index] = null
      cb(err);
    });
  };

  that.close = storage.close && function(cb) {
    storage.close(cb || noop);
  };

  that.remove = storage.remove && function(cb) {
    storage.remove(cb || noop);
  };

  return that
}
