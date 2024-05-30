const path = require("path");
const readDir = require("recursive-readdir");

const UPLOAD_IGNORES = [".DS_Store"];

const DEFAULT_UPLOAD_OPTIONS = {
  predefinedAcl: "publicRead",
};

const REQUIRED_GCS_OPTS = ["bucket"];
const PATH_SEP = path.sep;
const GCS_PATH_SEP = "/";
const DEFAULT_TRANSFORM = (item) => Promise.resolve(item);

const addTrailingGcsSep = (fPath) => {
  return fPath ? fPath.replace(/\/?(\?|#|$)/, "/$1") : fPath;
};

const addSeperatorToPath = (fPath) => {
  if (!fPath) return fPath;

  return fPath.endsWith(PATH_SEP) ? fPath : fPath + PATH_SEP;
};

const translatePathFromFiles = (rootPath) => {
  return (files) => {
    return files.map((file) => {
      return {
        path: file,
        name: file.replace(rootPath, "").split(PATH_SEP).join(GCS_PATH_SEP),
      };
    });
  };
};

const getDirectoryFilesRecursive = (dir, ignores = []) => {
  return new Promise((resolve, reject) => {
    readDir(dir, ignores, (err, files) => (err ? reject(err) : resolve(files)));
  }).then(translatePathFromFiles(dir));
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

function partition(arr, predicate) {
  const trueValues = [];
  const falseValues = [];

  for (let i = 0; i < arr.length; i++) {
    const value = arr[i];
    const isValid = predicate(value);
    if (isValid) {
      trueValues.push(value);
    } else {
      falseValues.push(value);
    }
  }

  return [trueValues, falseValues];
}

function uniq(arr, key) {
  const uniqueValues = {};
  const result = [];

  for (let i = 0; i < arr.length; i++) {
    const value = arr[i][key];

    if (!uniqueValues[value]) {
      uniqueValues[value] = true;
      result.push(arr[i]);
    }
  }

  return result;
}

module.exports = {
  UPLOAD_IGNORES,
  DEFAULT_UPLOAD_OPTIONS,
  REQUIRED_GCS_OPTS,
  PATH_SEP,
  GCS_PATH_SEP,
  DEFAULT_TRANSFORM,
  addTrailingGcsSep,
  addSeperatorToPath,
  translatePathFromFiles,
  getDirectoryFilesRecursive,
  testRule,
  isFunction,
  uniq,
  partition,
};
