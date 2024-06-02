const path = require("path");
const readDir = require("recursive-readdir");

const UPLOAD_IGNORE_LIST = [".DS_Store"];

const REQUIRED_GCS_OPTS = ["bucket"];
const PATH_SEP = path.sep;
const GCS_PATH_SEP = "/";
const identityTransform = (item) => Promise.resolve(item);

const appendGcsSeparator = (fPath) => {
  return fPath ? fPath.replace(/\/?(\?|#|$)/, "/$1") : fPath;
};

const addPathSeparator = (fPath) => {
  if (!fPath) return fPath;

  return fPath.endsWith(PATH_SEP) ? fPath : fPath + PATH_SEP;
};

const generateFilePaths = (rootPath) => {
  return (files) => {
    return files.map((file) => {
      return {
        path: file,
        name: file.replace(rootPath, "").split(PATH_SEP).join(GCS_PATH_SEP),
      };
    });
  };
};

const retrieveFilesRecursively = (dir, ignores = []) => {
  return new Promise((resolve, reject) => {
    readDir(dir, ignores, (err, files) => (err ? reject(err) : resolve(files)));
  }).then(generateFilePaths(dir));
};

const isRegExp = (value) => {
  return Object.prototype.toString.call(value) === "[object RegExp]";
};

const testRule = (rule, subject) => {
  if (isRegExp(rule)) {
    return rule.test(subject);
  } else if (typeof rule == "function") {
    return !!rule(subject);
  } else if (Array.isArray(rule)) {
    return rule.every((condition) => testRule(condition, subject));
  } else if (typeof rule == "string") {
    return new RegExp(rule).test(subject);
  } else {
    throw new Error("Invalid include / exclude rule");
  }
};

const isFunction = (fn) => typeof fn == "function";

module.exports = {
  UPLOAD_IGNORE_LIST,
  REQUIRED_GCS_OPTS,
  PATH_SEP,
  GCS_PATH_SEP,
  identityTransform,
  appendGcsSeparator,
  addPathSeparator,
  retrieveFilesRecursively,
  testRule,
  isFunction,
};
