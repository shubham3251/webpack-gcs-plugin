const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const cdnizer = require("cdnizer");
const mime = require("mime/lite");
const { Storage } = require("@google-cloud/storage");

const {
  addSeperatorToPath,
  addTrailingGcsSep,
  getDirectoryFilesRecursive,
  testRule,
  UPLOAD_IGNORES,
  DEFAULT_UPLOAD_OPTIONS,
  REQUIRED_GCS_OPTS,
  DEFAULT_TRANSFORM,
  isFunction,
  uniq,
  partition,
} = require("./helpers/index");

http.globalAgent.maxSockets = https.globalAgent.maxSockets = 50;

const compileError = (compilation, error) => {
  compilation.errors.push(new Error(error));
};

module.exports = class GcsPlugin {
  constructor(options = {}) {
    var {
      include,
      exclude,
      basePath,
      directory,
      htmlFiles,
      basePathTransform = DEFAULT_TRANSFORM,
      cdnizerOptions = {},
      gcsUploadOptions = { metadata: {} },
      priority,
      bucket,
    } = options;

    this.uploadOptions = gcsUploadOptions;
    this.isConnected = false;
    this.cdnizerOptions = cdnizerOptions;
    this.basePathTransform = basePathTransform;
    basePath = basePath ? addTrailingGcsSep(basePath) : "";

    this.options = {
      directory,
      include,
      exclude,
      basePath,
      priority,
      bucket,
      htmlFiles: typeof htmlFiles === "string" ? [htmlFiles] : htmlFiles,
    };

    this.noCdnizer = !Object.keys(this.cdnizerOptions).length;

    if (!this.noCdnizer && !this.cdnizerOptions.files)
      this.cdnizerOptions.files = [];
  }

  apply(compiler) {
    this.connect();

    const isDirectoryUpload = !!this.options.directory;

    const hasRequiredUploadOpts = REQUIRED_GCS_OPTS.reduce(
      (acc, opts) => acc && !!this.options[opts],
      true
    );
    // Set directory to output dir or custom
    this.options.directory =
      this.options.directory ||
      compiler.options.output.path ||
      compiler.options.output.context ||
      ".";

    compiler.hooks.done.tapPromise(
      "webpack-gcs-plugin",
      async ({ compilation }) => {
        let error;

        if (!hasRequiredUploadOpts)
          error = `GcsPlugin-RequiredGcsOpts: ${REQUIRED_GCS_OPTS.join(", ")}`;

        if (error) return compileError(compilation, error);

        if (isDirectoryUpload) {
          const dPath = addSeperatorToPath(this.options.directory);

          return this.getAllFilesRecursive(dPath)
            .then((files) => this.handleFiles(files))
            .catch((e) => this.handleErrors(e, compilation));
        } else {
          return this.getAssetFiles(compilation)
            .then((files) => this.handleFiles(files))
            .catch((e) => this.handleErrors(e, compilation));
        }
      }
    );
  }

  handleFiles(files) {
    return this.changeUrls(files)
      .then((files) => this.filterAllowedFiles(files))
      .then((files) => this.uploadFiles(files));
  }

  handleErrors(error, compilation) {
    compileError(compilation, `GcsPlugin: ${error}`);
    throw error;
  }

  getAllFilesRecursive(fPath) {
    return getDirectoryFilesRecursive(fPath);
  }

  addPathToFiles(files, fPath) {
    return files.map((file) => ({
      name: file,
      path: path.resolve(fPath, file),
    }));
  }

  getAssetFiles({ assets, outputOptions }) {
    const files = Object.keys(assets).map((name) => ({
      name,
      path: `${outputOptions.path}/${name}`,
    }));

    return Promise.resolve(files);
  }

  cdnizeHtml(file) {
    return new Promise((resolve, reject) => {
      fs.readFile(file.path, (err, data) => {
        if (err) return reject(err);

        fs.writeFile(file.path, this.cdnizer(data.toString()), (err) => {
          if (err) return reject(err);

          resolve(file);
        });
      });
    });
  }

  changeUrls(files = []) {
    if (this.noCdnizer) return Promise.resolve(files);

    let allHtml;

    const { directory, htmlFiles = [] } = this.options;

    if (htmlFiles.length)
      allHtml = this.addPathToFiles(htmlFiles, directory).concat(files);
    else allHtml = files;

    this.cdnizerOptions.files = allHtml.map(({ name }) => `{/,}*${name}*`);
    this.cdnizer = cdnizer(this.cdnizerOptions);

    const allHtmlWithUniqNames = uniq(allHtml, "name");
    const [cdnizeFiles, otherFiles] = partition(allHtmlWithUniqNames, (file) =>
      /\.(html|css)/.test(file.name)
    );

    return Promise.all(
      cdnizeFiles.map((file) => this.cdnizeHtml(file)).concat(otherFiles)
    );
  }

  filterAllowedFiles(files) {
    return files.reduce((res, file) => {
      if (
        this.isIncludeAndNotExclude(file.name) &&
        !this.isIgnoredFile(file.name)
      )
        res.push(file);

      return res;
    }, []);
  }

  isIgnoredFile(file) {
    return UPLOAD_IGNORES.some((ignore) => new RegExp(ignore).test(file));
  }

  isIncludeAndNotExclude(file) {
    var isExclude,
      isInclude,
      { include, exclude } = this.options;

    isInclude = include ? testRule(include, file) : true;
    isExclude = exclude ? testRule(exclude, file) : false;

    return isInclude && !isExclude;
  }

  connect() {
    if (this.isConnected) return;

    this.client = new Storage({});
    this.isConnected = true;
  }

  transformBasePath() {
    return Promise.resolve(this.basePathTransform(this.options.basePath))
      .then(addTrailingGcsSep)
      .then((nPath) => (this.options.basePath = nPath));
  }

  prioritizeFiles(files) {
    const prioritizedFiles = [];
    const remainingFiles = [...files];
    for (const reg of this.options.priority) {
      const matchedFiles = [];
      for (let i = remainingFiles.length - 1; i >= 0; i--) {
        if (reg.test(remainingFiles[i].name)) {
          matchedFiles.push(remainingFiles[i]);
          remainingFiles.splice(i, 1);
        }
      }
      prioritizedFiles.push(matchedFiles);
    }

    return [remainingFiles, ...prioritizedFiles];
  }

  async uploadFilesInChunk(files, chunkSize) {
    for (let i = 0; i < files.length; i += chunkSize) {
      const groupedFiles = files.slice(i, i + chunkSize);
      const uploadFiles = groupedFiles.map((file) =>
        this.uploadFile(file.name, file.path)
      );
      await Promise.all(uploadFiles);
    }
  }

  async uploadPriorityChunk(priorityChunk) {
    await this.uploadFilesInChunk(priorityChunk, 50);
  }

  async uploadInPriorityOrder(files) {
    const priorityChunks = this.prioritizeFiles(files);

    for (let chunk of priorityChunks) {
      await this.uploadPriorityChunk(chunk);
    }
  }

  async uploadFiles(files = []) {
    await this.transformBasePath();

    if (this.options.priority) {
      await this.uploadInPriorityOrder(files);
    } else {
      await this.uploadFilesInChunk(files, 50);
    }
  }

  async uploadFile(fileName, filePath) {
    let destination = this.options.basePath + fileName;

    const gcsParams = Object.entries(this.uploadOptions).reduce(
      (acc, [key, value]) => {
        return {
          ...acc,
          [key]: isFunction(value) ? value(fileName, filePath) : value,
        };
      },
      {}
    );

    // avoid noname folders in bucket
    if (destination[0] === "/") destination = destination.substr(1);

    if (gcsParams.metadata.contentType === undefined)
      gcsParams.metadata = {
        ...gcsParams.metadata,
        contentType: mime.getType(fileName),
      };

    const bucket = this.client.bucket(this.options.bucket);

    await bucket.upload(filePath, {
      ...DEFAULT_UPLOAD_OPTIONS,
      ...gcsParams,
      destination: destination,
    });
  }
};
