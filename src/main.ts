import {
  MarkdownView,
  Plugin,
  FileSystemAdapter,
  Editor,
  Menu,
  MenuItem,
  TFile,
  normalizePath,
  Notice,
  addIcon,
} from "obsidian";

import { resolve, extname, relative, join, parse, posix } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from 'os'

import {
  isAssetTypeAnImage,
  isAnImage,
  streamToString,
  getUrlAsset,
  isCopyImageFile,
  getLastImage,
} from "./utils";
import { PicGoUploader, PicGoCoreUploader } from "./uploader";
import Helper from "./helper";

import fetch from "node-fetch";

import { SettingTab, PluginSettings, DEFAULT_SETTINGS } from "./setting";

const REGEX_FILE = /\!\[(.*?)\]\((.*?)\)/g;

interface Image {
  path: string;
  name: string;
  source: string;
}

export default class imageAutoUploadPlugin extends Plugin {
  settings: PluginSettings;
  helper: Helper;
  editor: Editor;
  picGoUploader: PicGoUploader;
  picGoCoreUploader: PicGoCoreUploader;

  async loadSettings() {
    this.settings = Object.assign(DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {}

  async onload() {
    await this.loadSettings();

    this.helper = new Helper(this.app);
    this.picGoUploader = new PicGoUploader(this.settings);
    this.picGoCoreUploader = new PicGoCoreUploader(this.settings);

    addIcon(
      "upload",
      `<svg t="1636630783429" class="icon" viewBox="0 0 100 100" version="1.1" p-id="4649" xmlns="http://www.w3.org/2000/svg">
      <path d="M 71.638 35.336 L 79.408 35.336 C 83.7 35.336 87.178 38.662 87.178 42.765 L 87.178 84.864 C 87.178 88.969 83.7 92.295 79.408 92.295 L 17.249 92.295 C 12.957 92.295 9.479 88.969 9.479 84.864 L 9.479 42.765 C 9.479 38.662 12.957 35.336 17.249 35.336 L 25.019 35.336 L 25.019 42.765 L 17.249 42.765 L 17.249 84.864 L 79.408 84.864 L 79.408 42.765 L 71.638 42.765 L 71.638 35.336 Z M 49.014 10.179 L 67.326 27.688 L 61.835 32.942 L 52.849 24.352 L 52.849 59.731 L 45.078 59.731 L 45.078 24.455 L 36.194 32.947 L 30.702 27.692 L 49.012 10.181 Z" p-id="4650" fill="#8a8a8a"></path>
    </svg>`
    );

    this.addSettingTab(new SettingTab(this.app, this));

    this.addCommand({
      id: "upload all images",
      name: "upload all images",
      checkCallback: (checking: boolean) => {
        let leaf = this.app.workspace.activeLeaf;
        if (leaf) {
          if (!checking) {
            if (this.settings.uploader === "PicGo") {
              this.uploadAllFile();
            } else {
              new Notice("目前暂不支持 PicGo 客户端以外方式");
            }
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "doanload all images",
      name: "download all images",
      checkCallback: (checking: boolean) => {
        let leaf = this.app.workspace.activeLeaf;
        if (leaf) {
          if (!checking) {
            this.downloadAllImageFiles();
          }
          return true;
        }
        return false;
      },
    });

    this.setupPasteHandler();
    this.registerFileMenu();
  }

  ///TODO: asset路径处理（assets文件夹不存在处理），下载图片失败处理
  async downloadAllImageFiles() {
    const folderPath = this.getFileAssetPath();
    const fileArray = this.helper.getAllFiles();
    if (!existsSync(folderPath)) {
      mkdirSync(folderPath);
    }

    let imageArray = [];
    for (const file of fileArray) {
      if (!file.path.startsWith("http")) {
        continue;
      }

      const url = file.path;
      const asset = getUrlAsset(url);
      if (!isAnImage(asset.substr(asset.lastIndexOf(".")))) {
        continue;
      }
      let [name, ext] = [
        decodeURI(parse(asset).name).replaceAll(/[\\\\/:*?\"<>|]/g, "-"),
        parse(asset).ext,
      ];
      // 如果文件名已存在，则用随机值替换
      if (existsSync(join(folderPath, encodeURI(asset)))) {
        name = (Math.random() + 1).toString(36).substr(2, 5);
      }
      name = `image-${name}`;

      const response = await this.download(
        url,
        join(folderPath, `${name}${ext}`)
      );
      if (response.ok) {
        const activeFolder = this.app.vault.getAbstractFileByPath(
          this.app.workspace.getActiveFile().path
        ).parent.path;

        const basePath = (
          this.app.vault.adapter as FileSystemAdapter
        ).getBasePath();
        const abstractActiveFolder = resolve(basePath, activeFolder);

        imageArray.push({
          source: file.source,
          name: name,
          path: normalizePath(relative(abstractActiveFolder, response.path)),
        });
      }
    }

    let value = this.helper.getValue();
    imageArray.map(image => {
      value = value.replace(image.source, `![${image.name}](${image.path})`);
    });

    this.helper.setValue(value);

    new Notice(
      `all: ${fileArray.length}\nsuccess: ${imageArray.length}\nfailed: ${
        fileArray.length - imageArray.length
      }`
    );
  }

  // 获取当前文件所属的附件文件夹
  getFileAssetPath() {
    const basePath = (
      this.app.vault.adapter as FileSystemAdapter
    ).getBasePath();

    // @ts-ignore
    const assetFolder: string = this.app.vault.config.attachmentFolderPath;
    const activeFile = this.app.vault.getAbstractFileByPath(
      this.app.workspace.getActiveFile().path
    );

    // 当前文件夹下的子文件夹
    if (assetFolder.startsWith("./")) {
      const activeFolder = decodeURI(resolve(basePath, activeFile.parent.path));
      return join(activeFolder, assetFolder);
    } else {
      // 根文件夹
      return join(basePath, assetFolder);
    }
  }

  async download(url: string, path: string) {
    const response = await fetch(url);
    if (response.status !== 200) {
      return {
        ok: false,
        msg: response.statusText,
      };
    }
    const buffer = await response.buffer();
    try {
      writeFileSync(path, buffer);
      return {
        ok: true,
        msg: "ok",
        path: path,
      };
    } catch (err) {
      return {
        ok: false,
        msg: err,
      };
    }
  }

  registerFileMenu() {
    this.registerEvent(
      this.app.workspace.on(
        "file-menu",
        (menu: Menu, file: TFile, source: string) => {
          if (!isAssetTypeAnImage(file.path)) {
            return false;
          }
          menu.addItem((item: MenuItem) => {
            item
              .setTitle("Upload")
              .setIcon("upload")
              .onClick(() => {
                if (!(file instanceof TFile)) {
                  return false;
                }

                const basePath = (
                  this.app.vault.adapter as FileSystemAdapter
                ).getBasePath();

                const uri = decodeURI(resolve(basePath, file.path));

                this.picGoUploader.uploadFiles([uri]).then(res => {
                  if (res.success) {
                    let uploadUrl = [...res.result][0];

                    let value = this.helper
                      .getValue()
                      .replaceAll(
                        encodeURI(
                          relative(
                            this.app.workspace.getActiveFile().parent.path,
                            file.path
                          ).replaceAll("\\", "/")
                        ),
                        uploadUrl
                      );
                    this.helper.setValue(value);
                  }
                });
              });
          });
        }
      )
    );
  }

  // uploda all file
  async uploadAllFile() {
    let key = this.helper.getValue();

    const thisPath = this.app.vault.getAbstractFileByPath(
      this.app.workspace.getActiveFile().path
    );
    const basePath = (
      this.app.vault.adapter as FileSystemAdapter
    ).getBasePath();

    let imageList: Image[] = [];
    const fileArray = this.helper.getAllFiles();

    for (const match of fileArray) {
      const imageName = match.name;
      const encodedUri = match.path;
      if (!encodedUri.startsWith("http")) {
        let abstractImageFile;
        // 当路径以“.”开头时，识别为相对路径，不然就认为时绝对路径
        if (encodedUri.startsWith(".")) {
          abstractImageFile = decodeURI(
            join(
              basePath,
              posix.resolve(posix.join("/", thisPath.parent.path), encodedUri)
            )
          );
        } else {
          abstractImageFile = decodeURI(join(basePath, encodedUri));

          // 当解析为绝对路径却找不到文件，尝试解析为相对路径
          if (!existsSync(abstractImageFile)) {
            abstractImageFile = decodeURI(
              join(
                basePath,
                posix.resolve(posix.join("/", thisPath.parent.path), encodedUri)
              )
            );
          }
        }

        if (
          existsSync(abstractImageFile) &&
          isAssetTypeAnImage(abstractImageFile)
        ) {
          imageList.push({
            path: abstractImageFile,
            name: imageName,
            source: match.source,
          });
        }
      } else if (!(encodedUri.startsWith('https://raw.githubusercontent.com/'))) {
        const imagePath = join(tmpdir(), imageName);
        const response = await this.download(
          encodedUri,
          imagePath
         );
         if (response.ok) {
           imageList.push({
             path: imagePath,
             name: imageName,
             source: match.source,
           });
         }
      }
    }
    if (imageList.length === 0) {
      new Notice("没有解析到图像文件");
      return;
    } else {
      new Notice(`共找到${imageList.length}个图像文件，开始上传`);
    }
    console.log(imageList);

    this.picGoUploader
      .uploadFiles(imageList.map(item => item.path))
      .then(res => {
        if (res.success) {
          let uploadUrlList = [...res.result];
          imageList.map(item => {
            // gitea不能上传超过1M的数据，上传多张照片，错误的话会返回什么？还有待验证
            const uploadImage = uploadUrlList.shift();
            key = key.replaceAll(
              item.source,
              `![${item.name}](${uploadImage})`
            );
          });
          this.helper.setValue(key);
        }
      });
  }

  setupPasteHandler() {
    this.registerEvent(
      this.app.workspace.on(
        "editor-paste",
        (evt: ClipboardEvent, editor: Editor, markdownView: MarkdownView) => {
          const allowUpload = this.helper.getFrontmatterValue(
            "image-auto-upload",
            this.settings.uploadByClipSwitch
          );

          let files = evt.clipboardData.files;
          if (!allowUpload) {
            return;
          }
          if (
            isCopyImageFile() ||
            files.length !== 0 ||
            files[0].type.startsWith("image")
          ) {
            this.uploadFileAndEmbedImgurImage(
              editor,
              async (editor: Editor, pasteId: string) => {
                let res;
                if (this.settings.uploader === "PicGo") {
                  res = await this.picGoUploader.uploadFileByClipboard();
                } else if (this.settings.uploader === "PicGo-Core") {
                  res = await this.picGoCoreUploader.uploadByClipHandler();
                }

                if (res.code !== 0) {
                  this.handleFailedUpload(editor, pasteId, res.msg);
                  return;
                }
                const url = res.data;
                return url;
              }
            ).catch(console.error);
            evt.preventDefault();
          }
        }
      )
    );
    this.registerEvent(
      this.app.workspace.on(
        "editor-drop",
        async (evt: DragEvent, editor: Editor, markdownView: MarkdownView) => {
          const allowUpload = this.helper.getFrontmatterValue(
            "image-auto-upload",
            this.settings.uploadByClipSwitch
          );
          let files = evt.dataTransfer.files;

          if (!allowUpload) {
            return;
          }
          if (
            files.length !== 0 &&
            files[0].type.startsWith("image") &&
            this.settings.uploader !== "PicGo"
          ) {
            new Notice("目前暂不支持 PicGo 客户端以外方式");
            return;
          }

          if (files.length !== 0 && files[0].type.startsWith("image")) {
            let sendFiles: Array<String> = [];
            let files = evt.dataTransfer.files;
            Array.from(files).forEach((item, index) => {
              sendFiles.push(item.path);
            });
            evt.preventDefault();

            const data = await this.picGoUploader.uploadFiles(sendFiles);

            if (data.success) {
              data.result.map((value: string) => {
                let pasteId = (Math.random() + 1).toString(36).substr(2, 5);
                this.insertTemporaryText(editor, pasteId);
                this.embedMarkDownImage(editor, pasteId, value);
              });
            } else {
              new Notice("Upload error");
            }
          }
        }
      )
    );
  }

  async uploadFileAndEmbedImgurImage(editor: Editor, callback: Function) {
    let pasteId = (Math.random() + 1).toString(36).substr(2, 5);
    this.insertTemporaryText(editor, pasteId);

    try {
      const url = await callback(editor, pasteId);
      this.embedMarkDownImage(editor, pasteId, url);
    } catch (e) {
      this.handleFailedUpload(editor, pasteId, e);
    }
  }

  insertTemporaryText(editor: Editor, pasteId: string) {
    let progressText = imageAutoUploadPlugin.progressTextFor(pasteId);
    editor.replaceSelection(progressText + "\n");
  }

  private static progressTextFor(id: string) {
    return `![Uploading file...${id}]()`;
  }

  embedMarkDownImage(editor: Editor, pasteId: string, imageUrl: any) {
    let progressText = imageAutoUploadPlugin.progressTextFor(pasteId);
    let markDownImage = `![](${imageUrl})`;

    imageAutoUploadPlugin.replaceFirstOccurrence(
      editor,
      progressText,
      markDownImage
    );
  }

  handleFailedUpload(editor: Editor, pasteId: string, reason: any) {
    console.error("Failed request: ", reason);
    let progressText = imageAutoUploadPlugin.progressTextFor(pasteId);
    imageAutoUploadPlugin.replaceFirstOccurrence(
      editor,
      progressText,
      "⚠️upload failed, check dev console"
    );
  }

  static replaceFirstOccurrence(
    editor: Editor,
    target: string,
    replacement: string
  ) {
    let lines = editor.getValue().split("\n");
    for (let i = 0; i < lines.length; i++) {
      let ch = lines[i].indexOf(target);
      if (ch != -1) {
        let from = { line: i, ch: ch };
        let to = { line: i, ch: ch + target.length };
        editor.replaceRange(replacement, from, to);
        break;
      }
    }
  }
}
