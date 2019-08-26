
function Utils() {

}

/**
 * A different way to get the function name
 */

Utils.prototype.getFunctionName = function (func) {
    var ret = func.toString();
    ret = ret.substr('function '.length);
    ret = ret.substr(0, ret.indexOf('('));
    return ret;
  }

/**
 * https://stackoverflow.com/questions/2648293/how-to-get-the-function-name-from-within-that-function?utm_medium=organic&utm_source=google_rich_qa&utm_campaign=google_rich_qa
 */

Utils.prototype.getFunctionName2 = function (func) {
    // Match:
    // - ^          the beginning of the string
    // - function   the word 'function'
    // - \s+        at least some white space
    // - ([\w\$]+)  capture one or more valid JavaScript identifier characters
    // - \s*        optionally followed by white space (in theory there won't be any here,
    //              so if performance is an issue this can be omitted[1]
    // - \(         followed by an opening brace
    //
    var result = /^function\s+([\w\$]+)\s*\(/.exec( func.toString() )

    return  result  ?  result[ 1 ]  :  '' // for an anonymous function there won't be a match
}

var utils = utils || new Utils();

module.exports = utils;