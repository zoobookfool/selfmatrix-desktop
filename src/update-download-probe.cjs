"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { CancellationToken } = require("builder-util-runtime");
const { MinisignNsisUpdater } = require("./minisign-nsis-updater.cjs");
const { createVerifyUpdateCodeSignature } = require("./update-signature-verify.cjs");
const { blake2b512 } = require("./minisign-blake2b.cjs");

function rawPublicKeyBytes(publicKeyObject) {
  const jwk = publicKeyObject.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}

function encodePublicKeyFile({ keyId, publicKeyObject }) {
  const blob = Buffer.concat([Buffer.from("Ed", "ascii"), keyId, rawPublicKeyBytes(publicKeyObject)]);
  return `untrusted comment: update download probe key\n${blob.toString("base64")}\n`;
}

function encodeSignatureFile({ keyId, fileBytes, privateKey, fileName }) {
  const signedMessage = blake2b512(fileBytes);
  const signature = crypto.sign(null, signedMessage, privateKey);
  const signatureBlob = Buffer.concat([Buffer.from("ED", "ascii"), keyId, signature]);
  const trustedComment = `timestamp:1735689600\tfile:${fileName}`;
  const globalSignature = crypto.sign(
    null,
    Buffer.concat([signatureBlob, Buffer.from(trustedComment, "utf8")]),
    privateKey,
  );
  return (
    `untrusted comment: update download probe signature\n${signatureBlob.toString("base64")}\n` +
    `trusted comment: ${trustedComment}\n${globalSignature.toString("base64")}\n`
  );
}

function sha512(bytes) {
  return crypto.createHash("sha512").update(bytes).digest("base64");
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function runCase({ baseUrl, cacheRoot, name, installerBytes, verify }) {
  const installerUrl = new URL(`${name}.exe`, baseUrl);
  const fileInfo = {
    url: installerUrl,
    info: {
      url: `${name}.exe`,
      sha512: sha512(installerBytes),
    },
  };
  const updateInfo = {
    version: `9.9.${name === "valid" ? 1 : name === "missing" ? 2 : 3}`,
    files: [fileInfo.info],
    path: fileInfo.info.url,
    sha512: fileInfo.info.sha512,
  };
  const provider = {
    isUseMultipleRangeRequest: false,
    resolveFiles: () => [fileInfo],
  };
  const updater = new MinisignNsisUpdater({ verifyUpdateCodeSignature: verify });
  updater.app = {
    baseCachePath: cacheRoot,
    name: "SelfMatrixUpdateProbe",
    version: "0.1.0",
  };
  updater.configOnDisk = {
    value: Promise.resolve({ updaterCacheDirName: `selfmatrix-update-probe-${name}` }),
  };
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.disableWebInstaller = true;

  let updateDownloadedCount = 0;
  updater.on("update-downloaded", () => {
    updateDownloadedCount += 1;
  });

  let errorCode = null;
  let error = null;
  try {
    await updater.doDownloadUpdate({
      updateInfoAndProvider: { info: updateInfo, provider },
      requestHeaders: null,
      cancellationToken: new CancellationToken(),
      disableWebInstaller: true,
      disableDifferentialDownload: true,
    });
  } catch (caught) {
    errorCode = caught && caught.code ? caught.code : null;
    error = String(caught && caught.message ? caught.message : caught);
  } finally {
    if (updater.downloadedUpdateHelper) {
      await updater.downloadedUpdateHelper.clear();
    }
  }

  const expectedSuccess = name === "valid";
  return {
    name,
    expectedSuccess,
    updateDownloadedCount,
    errorCode,
    error,
    pass: expectedSuccess
      ? updateDownloadedCount === 1 && error === null
      : updateDownloadedCount === 0 && errorCode === "ERR_UPDATER_INVALID_SIGNATURE",
  };
}

async function runUpdateDownloadProbe() {
  const electronApp = require("electron").app;
  const cacheRoot = path.join(electronApp.getPath("userData"), "update-download-probe-cache");
  await fs.rm(cacheRoot, { recursive: true, force: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const keyId = crypto.randomBytes(8);
  const publicKeyText = encodePublicKeyFile({ keyId, publicKeyObject: keyPair.publicKey });
  const verify = createVerifyUpdateCodeSignature(publicKeyText);
  const originalBytes = Buffer.from("SelfMatrix updater integration probe\n", "utf8");
  const tamperedBytes = Buffer.from("SelfMatrix updater integration probe (tampered)\n", "utf8");
  const validSignature = encodeSignatureFile({
    keyId,
    fileBytes: originalBytes,
    privateKey: keyPair.privateKey,
    fileName: "valid.exe",
  });
  const tamperedSignature = encodeSignatureFile({
    keyId,
    fileBytes: originalBytes,
    privateKey: keyPair.privateKey,
    fileName: "tampered.exe",
  });

  const routes = new Map([
    ["/valid.exe", { status: 200, body: originalBytes }],
    ["/valid.exe.minisig", { status: 200, body: Buffer.from(validSignature, "utf8") }],
    ["/missing.exe", { status: 200, body: originalBytes }],
    ["/tampered.exe", { status: 200, body: tamperedBytes }],
    ["/tampered.exe.minisig", { status: 200, body: Buffer.from(tamperedSignature, "utf8") }],
  ]);
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    requests.push(pathname);
    const route = routes.get(pathname);
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(route.status, {
      "content-type": "application/octet-stream",
      "content-length": route.body.length,
    });
    response.end(route.body);
  });

  const port = await listen(server);
  const baseUrl = new URL(`http://127.0.0.1:${port}/`);
  let cases;
  try {
    cases = [];
    cases.push(await runCase({ baseUrl, cacheRoot, name: "valid", installerBytes: originalBytes, verify }));
    cases.push(await runCase({ baseUrl, cacheRoot, name: "missing", installerBytes: originalBytes, verify }));
    cases.push(await runCase({ baseUrl, cacheRoot, name: "tampered", installerBytes: tamperedBytes, verify }));
  } finally {
    await close(server);
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }

  const requiredRequests = [
    "/valid.exe",
    "/valid.exe.minisig",
    "/missing.exe",
    "/missing.exe.minisig",
    "/tampered.exe",
    "/tampered.exe.minisig",
  ];
  const allAssetsRequested = requiredRequests.every((pathname) => requests.includes(pathname));
  return {
    pass: cases.every((entry) => entry.pass) && allAssetsRequested,
    packaged: Boolean(electronApp.isPackaged),
    allAssetsRequested,
    requests,
    cases,
  };
}

module.exports = { runUpdateDownloadProbe };
