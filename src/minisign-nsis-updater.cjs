"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { NsisUpdater } = require("electron-updater");
const { verifyUpdateCodeSignature } = require("./update-signature-verify.cjs");

const MINISIGN_SUFFIX = ".minisig";

function installerSignatureUrl(installerUrl) {
  const signatureUrl = new URL(installerUrl.toString());
  signatureUrl.pathname = `${signatureUrl.pathname}${MINISIGN_SUFFIX}`;
  return signatureUrl;
}

function findInstallerFile(provider, updateInfo) {
  const files = provider.resolveFiles(updateInfo);
  const installer = files.find((file) => file.url.pathname.toLowerCase().endsWith(".exe"));
  if (!installer) {
    throw new Error("update metadata does not contain an NSIS .exe installer");
  }
  return installer;
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

// electron-updater's stock NsisUpdater only invokes its signature hook when
// app-update.yml contains publisherName, and it never downloads a sidecar
// signature. This subclass owns both operations so minisign is mandatory even
// for unsigned NSIS installers and cached pending updates cannot bypass it.
class MinisignNsisUpdater extends NsisUpdater {
  constructor(options = {}) {
    super(options.updaterOptions, options.app);
    this.verifyMinisignUpdate = options.verifyUpdateCodeSignature || verifyUpdateCodeSignature;
    this.signatureDownloadContext = null;
  }

  async doDownloadUpdate(downloadUpdateOptions) {
    const { info, provider } = downloadUpdateOptions.updateInfoAndProvider;
    const installer = findInstallerFile(provider, info);

    // AppUpdater accepts a previously cached installer without invoking the
    // NsisUpdater download task (and therefore without verifySignature()).
    // Clear only the pending-update cache before each attempt so every accepted
    // installer is downloaded and verified by this process. Differential base
    // data outside pending/ remains available.
    const helper = await this.getOrCreateDownloadHelper();
    await helper.clear();

    // バージョン束縛 (ダウングレード攻撃対策): electron-updater が latest.yml から読んだ
    // updateInfo.version と installer のファイル名 (URL の最終セグメント) を、後で
    // verifySignature() が verifyMinisignUpdate() へ渡す期待値として保持する。
    // installer.url.pathname は URL の pathname なので常に '/' 区切り (Windows でも) --
    // path.win32.basename ではなく path.posix.basename で切り出す。
    this.signatureDownloadContext = {
      installerUrl: installer.url,
      requestHeaders: downloadUpdateOptions.requestHeaders,
      cancellationToken: downloadUpdateOptions.cancellationToken,
      expectedVersion: info.version,
      expectedFileName: path.posix.basename(decodeURIComponent(installer.url.pathname)),
    };

    try {
      return await super.doDownloadUpdate(downloadUpdateOptions);
    } finally {
      this.signatureDownloadContext = null;
    }
  }

  async verifySignature(tempUpdateFile) {
    const context = this.signatureDownloadContext;
    if (!context) {
      return "minisign verification context is missing";
    }

    const signaturePath = `${tempUpdateFile}${MINISIGN_SUFFIX}`;
    const signatureUrl = installerSignatureUrl(context.installerUrl);
    await fs.rm(signaturePath, { force: true });

    try {
      await this.httpExecutor.download(signatureUrl, signaturePath, {
        headers: context.requestHeaders,
        cancellationToken: context.cancellationToken,
      });
      return await this.verifyMinisignUpdate([], tempUpdateFile, {
        expectedVersion: context.expectedVersion,
        expectedFileName: context.expectedFileName,
      });
    } catch (error) {
      return `minisign signature download/verification failed: ${errorMessage(error)}`;
    } finally {
      await fs.rm(signaturePath, { force: true }).catch(() => {});
    }
  }
}

module.exports = {
  MinisignNsisUpdater,
  installerSignatureUrl,
  findInstallerFile,
};
