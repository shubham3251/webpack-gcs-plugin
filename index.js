const mime = require("mime/lite");
const { Storage } = require("@google-cloud/storage");
const https = require("https");
const http = require("http");

const {
  addPathSeparator,
  appendGcsSeparator,
  retrieveFilesRecursively,
  testRule,
  UPLOAD_IGNORE_LIST,
  REQUIRED_GCS_OPTS,
  identityTransform,
  isFunction,
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
      basePathTransform = identityTransform,
      projectId,
      gcsUploadOptions = { metadata: {} },
      priority,
      bucket,
    } = options;

    this.uploadOptions = gcsUploadOptions;
    this.isConnected = false;
    this.basePathTransform = basePathTransform;
    basePath = basePath ? appendGcsSeparator(basePath) : "";

    this.options = {
      directory,
      include,
      exclude,
      basePath,
      priority,
      bucket,
      projectId,
      htmlFiles: typeof htmlFiles === "string" ? [htmlFiles] : htmlFiles,
    };
  }

  apply(compiler) {
    this.connect();

    const hasNecessaryUploadOptions = REQUIRED_GCS_OPTS.reduce(
      (acc, opts) => acc && !!this.options[opts],
      true
    );
    // Set directory to output dir or custom
    this.options.directory =
      this.options.directory ||
      compiler.options.output.path ||
      compiler.options.output.context ||
      ".";

    const isDirectoryAvailable = !!this.options.directory;

    compiler.hooks.done.tapPromise(
      "webpack-gcs-plugin",
      async ({ compilation }) => {
        let error;

        if (!hasNecessaryUploadOptions)
          error = `GcsPlugin-RequiredGcsOpts: ${REQUIRED_GCS_OPTS.join(", ")}`;

        if (error) return compileError(compilation, error);

        if (isDirectoryAvailable) {
          const dPath = addPathSeparator(this.options.directory);

          return retrieveFilesRecursively(dPath)
            .then((files) => this.manageFiles(files))
            .catch((e) => this.handleExceptions(e, compilation));
        } else {
          return this.fetchAssetFiles(compilation)
            .then((files) => this.manageFiles(files))
            .catch((e) => this.handleExceptions(e, compilation));
        }
      }
    );
  }

  manageFiles(files) {
    const permittedFiles = this.filterPermittedFiles(files);
    return this.uploadFiles(permittedFiles);
  }

  handleExceptions(error, compilation) {
    compileError(compilation, `GcsPlugin: ${error}`);
    throw error;
  }

  fetchAssetFiles({ assets, outputOptions }) {
    const files = Object.keys(assets).map((name) => ({
      name,
      path: `${outputOptions.path}/${name}`,
    }));

    return Promise.resolve(files);
  }

  filterPermittedFiles(files) {
    return files.reduce((res, file) => {
      if (
        this.isWhitelistedAndNotBlacklisted(file.name) &&
        !this.isFileIgnored(file.name)
      )
        res.push(file);

      return res;
    }, []);
  }

  isFileIgnored(file) {
    return UPLOAD_IGNORE_LIST.some((ignore) => new RegExp(ignore).test(file));
  }

  isWhitelistedAndNotBlacklisted(file) {
    var isExclude,
      isInclude,
      { include, exclude } = this.options;

    isInclude = include ? testRule(include, file) : true;
    isExclude = exclude ? testRule(exclude, file) : false;

    return isInclude && !isExclude;
  }

  connect() {
    if (this.isConnected) return;

    this.client = new Storage({ projectId: this.options.projectId });
    this.isConnected = true;
  }

  updateBasePath() {
    return Promise.resolve(this.basePathTransform(this.options.basePath))
      .then(appendGcsSeparator)
      .then((nPath) => (this.options.basePath = nPath));
  }

  async uploadFilesInChunk(files, chunkSize) {
    for (let i = 0; i < files.length; i += chunkSize) {
      const groupedFiles = files.slice(i, i + chunkSize);
      const uploadFiles = groupedFiles.map((file) =>
        this.uploadToBucket(file.name, file.path)
      );
      await Promise.all(uploadFiles);
    }
  }

  async uploadFiles(files = []) {
    await this.updateBasePath();

    await this.uploadFilesInChunk(files, 50);
  }

  async uploadToBucket(fileName, filePath) {
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

    if (
      gcsParams.metadata == undefined ||
      gcsParams.metadata.contentType === undefined
    ) {
      gcsParams.metadata = {
        ...gcsParams.metadata,
        contentType: mime.getType(fileName),
      };
    }

    const bucket = this.client.bucket(this.options.bucket);

    await bucket.upload(filePath, {
      ...gcsParams,
      destination: destination,
    });
  }
};
