import { 
  TFile, 
  Plugin, 
  WorkspaceLeaf, 
  addIcon, 
  App, 
  PluginManifest, 
  MarkdownView,
  normalizePath,
  MarkdownPostProcessorContext,
  Menu,
  MenuItem,
  TAbstractFile,
  Tasks,
  MarkdownRenderer,
  ViewState,
  Notice,
  TFolder,
  Modal,
} from "obsidian";

import { 
  BLANK_DRAWING,
  VIEW_TYPE_EXCALIDRAW, 
  EXCALIDRAW_ICON,
  ICON_NAME,
  DISK_ICON,
  DISK_ICON_NAME,
  PNG_ICON,
  PNG_ICON_NAME,
  SVG_ICON,
  SVG_ICON_NAME,
  RERENDER_EVENT,
  FRONTMATTER_KEY,
  FRONTMATTER,
  //LOCK_ICON,
  TEXT_DISPLAY_PARSED_ICON_NAME,
  TEXT_DISPLAY_RAW_ICON_NAME,
  //UNLOCK_ICON,
  JSON_parse
} from "./constants";
import ExcalidrawView, {ExportSettings, TextMode} from "./ExcalidrawView";
import {getJSON} from "./ExcalidrawData";
import {
  ExcalidrawSettings, 
  DEFAULT_SETTINGS, 
  ExcalidrawSettingTab
} from "./settings";
import {
  openDialogAction, 
  OpenFileDialog
} from "./openDrawing";
import {
  initExcalidrawAutomate,
  destroyExcalidrawAutomate,
  exportSceneToMD,
} from "./ExcalidrawAutomate";
import { Prompt } from "./Prompt";
import { around } from "monkey-around";
import { t } from "./lang/helpers";
import { MigrationPrompt } from "./MigrationPrompt";
import { checkAndCreateFolder, download, getIMGPathFromExcalidrawFile, getNewUniqueFilepath } from "./Utils";

export default class ExcalidrawPlugin extends Plugin {
  public excalidrawFileModes: { [file: string]: string } = {};
  private _loaded: boolean = false;
  public settings: ExcalidrawSettings;
  //public stencilLibrary: any = null;
  private openDialog: OpenFileDialog;
  private activeExcalidrawView: ExcalidrawView = null;
  public lastActiveExcalidrawFilePath: string = null;
  private hover: {linkText: string, sourcePath: string} = {linkText: null, sourcePath: null};
  private observer: MutationObserver;
  private fileExplorerObserver: MutationObserver;
  public opencount:number = 0;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
  }
  
  async onload() {
    addIcon(ICON_NAME, EXCALIDRAW_ICON);
    addIcon(DISK_ICON_NAME,DISK_ICON);
    addIcon(PNG_ICON_NAME,PNG_ICON);
    addIcon(SVG_ICON_NAME,SVG_ICON);
    //addIcon(TEXT_DISPLAY_PARSED_ICON_NAME,LOCK_ICON);
    //addIcon(TEXT_DISPLAY_RAW_ICON_NAME,UNLOCK_ICON);
    
    await this.loadSettings();
    this.addSettingTab(new ExcalidrawSettingTab(this.app, this));
    await initExcalidrawAutomate(this);

    this.registerView(
      VIEW_TYPE_EXCALIDRAW, 
      (leaf: WorkspaceLeaf) => new ExcalidrawView(leaf, this)
    );

    //Compatibility mode with .excalidraw files
    this.registerExtensions(["excalidraw"],VIEW_TYPE_EXCALIDRAW);

    this.addMarkdownPostProcessor();
    this.experimentalFileTypeDisplayToggle(this.settings.experimentalFileType);
    this.registerCommands();
    this.registerEventListeners();
    
    //inspiration taken from kanban: 
    //https://github.com/mgmeyers/obsidian-kanban/blob/44118e25661bff9ebfe54f71ae33805dc88ffa53/src/main.ts#L267
    this.registerMonkeyPatches();
    if(this.settings.loadCount<1) this.migrationNotice();
    
  }

  private migrationNotice(){
    const self = this;
    this.app.workspace.onLayoutReady(async () => {
      self.settings.loadCount++;
      self.saveSettings();
      const files = this.app.vault.getFiles().filter((f)=>f.extension=="excalidraw");  
      if(files.length>0) {
        const prompt = new MigrationPrompt(self.app, self);
        prompt.open();
      }
    });
  }
  /**
   * Displays a transcluded .excalidraw image in markdown preview mode
   */
  private addMarkdownPostProcessor() {
    
    interface imgElementAttributes {
      fname:   string, //Excalidraw filename
      fwidth:  string, //Display width of image
      fheight: string, //Display height of image
      style:   string  //css style to apply to IMG element
    }

    /**
     * Generates an img element with the .excalidraw drawing encoded as a base64 svg
     * @param parts {imgElementAttributes} - display properties of the image
     * @returns {Promise<HTMLElement>} - the IMG HTML element containing the encoded SVG image
     */
    const getIMG = async (parts:imgElementAttributes):Promise<HTMLElement> => {
      const file = this.app.vault.getAbstractFileByPath(parts.fname);
      if(!(file && file instanceof TFile)) {
        return null;
      }
    
      const content = await this.app.vault.read(file);
      const exportSettings: ExportSettings = {
        withBackground: this.settings.exportWithBackground, 
        withTheme: this.settings.exportWithTheme
      }
      let svg = await ExcalidrawView.getSVG(JSON_parse(getJSON(content)),exportSettings);
      if(!svg) return null;
      svg = ExcalidrawView.embedFontsInSVG(svg);
      const img = createEl("img");
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      img.setAttribute("width",parts.fwidth);
      
      if(parts.fheight) img.setAttribute("height",parts.fheight);
      img.addClass(parts.style);
      img.setAttribute("src","data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg.outerHTML.replaceAll("&nbsp;"," ")))));
      return img;
    }

    /**
     * 
     * @param el 
     * @param ctx 
     */
    const markdownPostProcessor = async (el:HTMLElement,ctx:MarkdownPostProcessorContext) => {
      const drawings = el.querySelectorAll('.internal-embed');
      if(drawings.length==0) return;

      let attr:imgElementAttributes={fname:"",fheight:"",fwidth:"",style:""};
      let alt:string, img:any, parts, div, file:TFile;
      for (const drawing of drawings) {
        attr.fname = drawing.getAttribute("src");
        file = this.app.metadataCache.getFirstLinkpathDest(attr.fname, ctx.sourcePath); 
        if(file && file instanceof TFile && this.isExcalidrawFile(file)) {  
          attr.fwidth   = drawing.getAttribute("width") ? drawing.getAttribute("width") : this.settings.width;
          attr.fheight  = drawing.getAttribute("height");
          alt = drawing.getAttribute("alt");
          if(alt == attr.fname) alt = ""; //when the filename starts with numbers followed by a space Obsidian recognizes the filename as alt-text
          attr.style = "excalidraw-svg";
          if(alt) {
            //for some reason ![]() is rendered in a DIV and ![[]] in a span by Obsidian
            //also the alt text of the DIV does not include the altext of the image
            //thus need to add an additional "|" character when its a span
            if(drawing.tagName.toLowerCase()=="span") alt = "|"+alt;
            parts = alt.match(/[^\|]*\|?(\d*)x?(\d*)\|?(.*)/);
            attr.fwidth = parts[1]? parts[1] : this.settings.width;
            attr.fheight = parts[2];
            if(parts[3]!=attr.fname) attr.style = "excalidraw-svg" + (parts[3] ? "-" + parts[3] : "");
          }
        
          attr.fname = file?.path;
          img = await getIMG(attr);
          div = createDiv(attr.style, (el)=>{
            el.append(img);
            el.setAttribute("src",file.path);
            if(attr.fwidth) el.setAttribute("w",attr.fwidth);
            if(attr.fheight) el.setAttribute("h",attr.fheight);
            el.onClickEvent((ev)=>{
              if(ev.target instanceof Element && ev.target.tagName.toLowerCase() != "img") return;
              let src = el.getAttribute("src");
              if(src) this.openDrawing(this.app.vault.getAbstractFileByPath(src) as TFile,ev.ctrlKey||ev.metaKey);
            });
            el.addEventListener(RERENDER_EVENT, async(e) => {
              e.stopPropagation;
              el.empty();
              const img = await getIMG({ 
                fname:el.getAttribute("src"),
                fwidth:el.getAttribute("w"),
                fheight:el.getAttribute("h"),
                style:el.getAttribute("class")
              });
              el.append(img);
            });
          });
          drawing.parentElement.replaceChild(div,drawing);
        } 
      }
    }

    this.registerMarkdownPostProcessor(markdownPostProcessor);

    /**
     * internal-link quick preview 
     * @param e 
     * @returns 
     */
    const hoverEvent = (e:any) => {
      if(!e.linktext) {
        this.hover.linkText = null;
        return;
      }
      this.hover.linkText = e.linktext;
      this.hover.sourcePath = e.sourcePath;      
    };   
    this.registerEvent(
      //@ts-ignore
      this.app.workspace.on('hover-link',hoverEvent)
    );
      
    //monitoring for div.popover.hover-popover.file-embed.is-loaded to be added to the DOM tree
    this.observer = new MutationObserver((m)=>{
      if(m.length == 0) return;
      if(!this.hover.linkText) return;
      const file = this.app.metadataCache.getFirstLinkpathDest(this.hover.linkText, this.hover.sourcePath?this.hover.sourcePath:""); 
      if(!file || !(file instanceof TFile) || !this.isExcalidrawFile(file)) return
   
      if((file as TFile).extension == "excalidraw") {
        observerForLegacyFileFormat(m,file);
        return;
      }
      
      let i=0;
      //@ts-ignore      
      while(i<m.length && m[i].target?.className!="markdown-preview-sizer markdown-preview-section") i++;
      if(i==m.length) return;
      if(m[i].addedNodes.length==0) return;
      //@ts-ignore
      if(m[i].addedNodes[0].childElementCount!=2) return;
      //@ts-ignore
      if(m[i].addedNodes[0].firstElementChild.className.indexOf("frontmatter")==-1) return;
      //@ts-ignore
      if(m[i].addedNodes[0].firstElementChild?.firstElementChild?.className=="excalidraw-svg") return;
      
      //@ts-ignore
      if(!m[i].addedNodes[0].matchParent(".hover-popover")) return;

      //this div will be on top of original DIV. By stopping the propagation of the click
      //I prevent the default Obsidian feature of openning the link in the native app
      const div = createDiv("",async (el)=>{
        const img = await getIMG({fname:file.path,fwidth:"300",fheight:null,style:"excalidraw-svg"});
        el.appendChild(img);
        el.setAttribute("src",file.path);
        el.onClickEvent((ev)=>{
          ev.stopImmediatePropagation();
          let src = el.getAttribute("src");
          if(src) this.openDrawing(this.app.vault.getAbstractFileByPath(src) as TFile,ev.ctrlKey||ev.metaKey);
        });
      });
      m[i].addedNodes[0].insertBefore(div,m[i].addedNodes[0].firstChild)
      
    });

    //compatibility: .excalidraw file observer
    let observerForLegacyFileFormat = (m:MutationRecord[], file:TFile) => {
      if(!this.hover.linkText) return;
      if(m.length!=1) return;
      if(m[0].addedNodes.length != 1) return;
      //@ts-ignore
      if(m[0].addedNodes[0].className!="popover hover-popover file-embed is-loaded") return;
      const node = m[0].addedNodes[0];
      node.empty();
      
      //this div will be on top of original DIV. By stopping the propagation of the click
      //I prevent the default Obsidian feature of openning the link in the native app
      const div = createDiv("",async (el)=>{
        const img = await getIMG({fname:file.path,fwidth:"300",fheight:null,style:"excalidraw-svg"});
        el.appendChild(img);
        el.setAttribute("src",file.path);
        el.onClickEvent((ev)=>{
          ev.stopImmediatePropagation();
          let src = el.getAttribute("src");
          if(src) this.openDrawing(this.app.vault.getAbstractFileByPath(src) as TFile,ev.ctrlKey||ev.metaKey);
        });
      });
      node.appendChild(div);
    }
    this.observer.observe(document, {childList: true, subtree: true});

    

  }

  public experimentalFileTypeDisplayToggle(enabled: boolean) {
    if(enabled) {
      this.experimentalFileTypeDisplay();
      return;
    }
    if(this.fileExplorerObserver) this.fileExplorerObserver.disconnect();
    this.fileExplorerObserver = null;
  }

  private experimentalFileTypeDisplay() {
    this.fileExplorerObserver = new MutationObserver((m)=>{

      const mutationsWithNodes = m.filter((v)=>v.addedNodes.length > 0);
      mutationsWithNodes.forEach((mu)=>{
        mu.addedNodes.forEach((n)=>{
          if(!(n instanceof Element)) return;
          n.querySelectorAll(".nav-file-title").forEach((el)=>{
            if(el.childElementCount == 1) {
              //@ts-ignore
              if(this.isExcalidrawFile(this.app.vault.getAbstractFileByPath(el.attributes["data-path"].value))) {
                el.insertBefore(createDiv({cls:"nav-file-tag",text:this.settings.experimentalFileTag}),el.firstChild);
              }
            }
          });
        });
      });
    });

    const self = this;
    this.app.workspace.onLayoutReady(()=>{
      document.querySelectorAll(".nav-file-title").forEach((el)=>{
        if(el.childElementCount == 1) {
          //@ts-ignore
          if(this.isExcalidrawFile(this.app.vault.getAbstractFileByPath(el.attributes["data-path"].value))) {
            el.insertBefore(createDiv({cls:"nav-file-tag",text:this.settings.experimentalFileTag}),el.firstChild);
          }
        }
      });
      this.fileExplorerObserver.observe(document.querySelector(".workspace"), {childList: true, subtree: true});
    });
    
  }

  private registerCommands() {
    this.openDialog = new OpenFileDialog(this.app, this);

    this.addRibbonIcon(ICON_NAME, t("CREATE_NEW"), async (e) => {
      this.createDrawing(this.getNextDefaultFilename(), e.ctrlKey||e.metaKey);
    });
  
    const fileMenuHandlerCreateNew = (menu: Menu, file: TFile) => {
      menu.addItem((item: MenuItem) => {
        item.setTitle(t("CREATE_NEW"))
          .setIcon(ICON_NAME)
          .onClick(evt => {
            let folderpath = file.path;
            if(file instanceof TFile) {
              folderpath = normalizePath(file.path.substr(0,file.path.lastIndexOf(file.name)));  
            }
            this.createDrawing(this.getNextDefaultFilename(),false,folderpath);
          })
      });      
    };

    this.registerEvent(
      this.app.workspace.on("file-menu", fileMenuHandlerCreateNew)
    );

    const fileMenuHandlerConvertKeepExtension = (menu: Menu, file: TFile) => {
      if(file instanceof TFile && file.extension == "excalidraw") {
        menu.addItem((item: MenuItem) => {
          item.setTitle(t("CONVERT_FILE_KEEP_EXT"))
            .onClick(evt => {        
                this.convertSingleExcalidrawToMD(file,false,false);
            })
        });   
      }   
    };

    this.registerEvent(
      this.app.workspace.on("file-menu", fileMenuHandlerConvertKeepExtension)
    );

    const fileMenuHandlerConvertReplaceExtension = (menu: Menu, file: TFile) => {
      if(file instanceof TFile && file.extension == "excalidraw") {
        menu.addItem((item: MenuItem) => {
          item.setTitle(t("CONVERT_FILE_REPLACE_EXT"))
            .onClick(evt => {        
                this.convertSingleExcalidrawToMD(file,true,true);
            })
        });   
      }   
    };

    this.registerEvent(
      this.app.workspace.on("file-menu", fileMenuHandlerConvertReplaceExtension)
    );

    this.addCommand({
      id: "excalidraw-download-lib",
      name: t("DOWNLOAD_LIBRARY"),
      callback: async () => {
        //@ts-ignore
        if(this.app.isMobile) {
          const prompt = new Prompt(this.app, "Please provide a filename",'my-library','filename, leave blank to cancel action');
          prompt.openAndGetValue( async (filename:string)=> {
            if(!filename) return;
            filename = filename + ".excalidrawlib";
            const folderpath = normalizePath(this.settings.folder);
            await checkAndCreateFolder(this.app.vault,folderpath); //create folder if it does not exist         
            const fname = getNewUniqueFilepath(this.app.vault,filename,folderpath);
            this.app.vault.create(fname,this.settings.library);
            new Notice("Exported library to " + fname,6000);  
          });
          return;
        }
        download('data:text/plain;charset=utf-8',encodeURIComponent(this.settings.library), 'my-obsidian-library.excalidrawlib');
      },
    });

    this.addCommand({
      id: "excalidraw-open",
      name: t("OPEN_EXISTING_NEW_PANE"),
      callback: () => {
        this.openDialog.start(openDialogAction.openFile, true);
      },
    });

    this.addCommand({
      id: "excalidraw-open-on-current",
      name: t("OPEN_EXISTING_ACTIVE_PANE"),
      callback: () => {
        this.openDialog.start(openDialogAction.openFile, false);
      },
    });

    this.addCommand({
      id: "excalidraw-insert-transclusion",
      name: t("TRANSCLUDE"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          return this.app.workspace.activeLeaf.view.getViewType() == "markdown";
        } else {
          this.openDialog.start(openDialogAction.insertLinkToDrawing, false);
          return true;
        }
      },
    });

    this.addCommand({
      id: "excalidraw-insert-last-active-transclusion",
      name: t("TRANSCLUDE_MOST_RECENT"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          return (this.app.workspace.activeLeaf.view.getViewType() == "markdown") && (this.lastActiveExcalidrawFilePath!=null);
        } else {
          this.embedDrawing(this.lastActiveExcalidrawFilePath);
          return true;
        }
      },
    });

    this.addCommand({
      id: "excalidraw-autocreate",
      name: t("NEW_IN_NEW_PANE"),
      callback: () => {
        this.createDrawing(this.getNextDefaultFilename(), true);
      },
    });

    this.addCommand({
      id: "excalidraw-autocreate-on-current",
      name: t("NEW_IN_ACTIVE_PANE"),
      callback: () => {
        this.createDrawing(this.getNextDefaultFilename(), false);
      },
    });

    this.addCommand({
      id: "excalidraw-autocreate-and-embed",
      name: t("NEW_IN_NEW_PANE_EMBED"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          return (this.app.workspace.activeLeaf.view.getViewType() == "markdown");
        } else {
          const filename = this.getNextDefaultFilename();
          this.embedDrawing(filename);
          this.createDrawing(filename, true);
          return true;
        }
      },
    });

    this.addCommand({
      id: "excalidraw-autocreate-and-embed-on-current",
      name: t("NEW_IN_ACTIVE_PANE_EMBED"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          return (this.app.workspace.activeLeaf.view.getViewType() == "markdown");
        } else {
          const filename = this.getNextDefaultFilename();
          this.embedDrawing(filename);
          this.createDrawing(filename, false);
          return true;
        }
      },
    });

    this.addCommand({
      id: "export-svg",
      name: t("EXPORT_SVG"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          return this.app.workspace.activeLeaf.view.getViewType() == VIEW_TYPE_EXCALIDRAW;
        } else {
          const view = this.app.workspace.activeLeaf.view;
          if (view instanceof ExcalidrawView) {
            view.saveSVG();
            return true;
          }
          else return false;
        }
      },
    });

    this.addCommand({
      id: "export-png",
      name: t("EXPORT_PNG"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          return this.app.workspace.activeLeaf.view.getViewType() == VIEW_TYPE_EXCALIDRAW;
        } else {
          const view = this.app.workspace.activeLeaf.view;
          if (view instanceof ExcalidrawView) {
            view.savePNG();
            return true;
          }
          else return false;
        }
      },
    });

    this.addCommand({
      id: "toggle-lock",
      hotkeys: [{modifiers:["Ctrl" || "Meta","Shift"], key:"e"}],
      name: t("TOGGLE_LOCK"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          if(this.app.workspace.activeLeaf.view.getViewType() == VIEW_TYPE_EXCALIDRAW) {
            return !(this.app.workspace.activeLeaf.view as ExcalidrawView).compatibilityMode;
          }
          return false;
        } else {
          const view = this.app.workspace.activeLeaf.view;
          if (view instanceof ExcalidrawView) {
            view.changeTextMode((view.textMode==TextMode.parsed)?TextMode.raw:TextMode.parsed);
            return true;
          }
          else return false;
        }
      },
    });

    this.addCommand({
      id: "insert-link",
      hotkeys: [{modifiers:["Ctrl" || "Meta","Shift"], key:"k"}],
      name: t("INSERT_LINK"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          const view = this.app.workspace.activeLeaf.view;
          return (view instanceof ExcalidrawView);
        } else {
          const view = this.app.workspace.activeLeaf.view;
          if (view instanceof ExcalidrawView) {
            this.openDialog.insertLink(view.file.path,view.addText);
            return true;
          }
          else return false;
        }
      },
    });

    this.addCommand({
      id: "insert-LaTeX-symbol",
      name: t("INSERT_LATEX"),
      checkCallback: (checking: boolean) => {
        if (checking) {
          return this.app.workspace.activeLeaf.view.getViewType() == VIEW_TYPE_EXCALIDRAW;
        } else {
          const view = this.app.workspace.activeLeaf.view;
          if (view instanceof ExcalidrawView) {
            const prompt = new Prompt(this.app, t("ENTER_LATEX"),'','$\\theta$');
            prompt.openAndGetValue( async (formula:string)=> {
              if(!formula) return;
              const el = createEl('p');
              await MarkdownRenderer.renderMarkdown(formula,el,'',this)
              view.addText(el.getText());
              el.empty();
            });
            return true;
          }
          else return false;
        }
      },
    });

    this.addCommand({
      id: "toggle-excalidraw-view",
      name: t("TOGGLE_MODE"),
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;
        const fileIsExcalidraw = this.isExcalidrawFile(activeFile);

        if (checking) {
          if(this.app.workspace.activeLeaf.view.getViewType() == VIEW_TYPE_EXCALIDRAW) {
            return !(this.app.workspace.activeLeaf.view as ExcalidrawView).compatibilityMode;
          }
          return fileIsExcalidraw;
        }

        const activeLeaf = this.app.workspace.activeLeaf;

        if (activeLeaf?.view && activeLeaf.view instanceof ExcalidrawView) {
          this.excalidrawFileModes[(activeLeaf as any).id || activeFile.path] =
            "markdown";
          this.setMarkdownView(activeLeaf);
        } else if (fileIsExcalidraw) {
          this.excalidrawFileModes[(activeLeaf as any).id || activeFile.path] =
            VIEW_TYPE_EXCALIDRAW;
          this.setExcalidrawView(activeLeaf);
        }
      },
    });

    this.addCommand({
      id: "convert-to-excalidraw",
      name: t("CONVERT_NOTE_TO_EXCALIDRAW"),
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();
        const activeLeaf = this.app.workspace.activeLeaf;

        if (!activeFile || !activeLeaf) return false;

        const isFileEmpty = activeFile.stat.size === 0;

        if (checking) return isFileEmpty;
        if (isFileEmpty) {
          (async()=>{
            await this.app.vault.modify(activeFile, await this.getBlankDrawing());
            this.setExcalidrawView(activeLeaf);  
          })();
        }
      },
    });
   
    this.addCommand({
      id: "convert-excalidraw",
      name: t("CONVERT_EXCALIDRAW"),
      checkCallback: (checking) => {
        if (checking) {
          const files = this.app.vault.getFiles().filter((f)=>f.extension=="excalidraw");
          return files.length>0;
        }
        this.convertExcalidrawToMD()
        return true;
      }
    });
  }
  
  public async convertSingleExcalidrawToMD(file: TFile, replaceExtension:boolean = false, keepOriginal:boolean = false):Promise<TFile> {
    const data = await this.app.vault.read(file);
    const filename = file.name.substr(0,file.name.lastIndexOf(".excalidraw")) + (replaceExtension ? ".md" : ".excalidraw.md");
    const fname = getNewUniqueFilepath(this.app.vault,filename,normalizePath(file.path.substr(0,file.path.lastIndexOf(file.name))));
    console.log(fname);
    const result = await this.app.vault.create(fname,FRONTMATTER + exportSceneToMD(data));
    if (this.settings.keepInSync) {
      ['.svg','.png'].forEach( (ext:string)=>{
        const oldIMGpath = file.path.substring(0,file.path.lastIndexOf(".excalidraw")) + ext;   
        const imgFile = this.app.vault.getAbstractFileByPath(normalizePath(oldIMGpath));
        if(imgFile && imgFile instanceof TFile) {
          const newIMGpath = fname.substr(0,fname.lastIndexOf(".md"))  + ext;
          this.app.vault.rename(imgFile,newIMGpath); 
        }
      });
    }
    if (!keepOriginal) this.app.vault.delete(file);
    return result;
  }

  public async convertExcalidrawToMD(replaceExtension:boolean = false, keepOriginal:boolean = false) {
    const files = this.app.vault.getFiles().filter((f)=>f.extension=="excalidraw");
    for (const file of files) {
      this.convertSingleExcalidrawToMD(file,replaceExtension,keepOriginal);
    }
    new Notice("Converted " + files.length + " files.")
  }

  private registerMonkeyPatches() {
    const self = this;

    // Monkey patch WorkspaceLeaf to open Excalidraw drawings with ExcalidrawView by default
    this.register(
      around(WorkspaceLeaf.prototype, {
        // Drawings can be viewed as markdown or Excalidraw, and we keep track of the mode
        // while the file is open. When the file closes, we no longer need to keep track of it.
        detach(next) {
          return function () {
            const state = this.view?.getState();

            if (state?.file && self.excalidrawFileModes[this.id || state.file]) {
              delete self.excalidrawFileModes[this.id || state.file];
            }

            return next.apply(this);
          };
        },

        setViewState(next) {
          return function (state: ViewState, ...rest: any[]) {
            if (
              // Don't force excalidraw mode during shutdown
              self._loaded &&
              // If we have a markdown file
              state.type === "markdown" &&
              state.state?.file &&
              // And the current mode of the file is not set to markdown
              self.excalidrawFileModes[this.id || state.state.file] !== "markdown"
            ) {
              // Then check for the excalidraw frontMatterKey
              const cache = self.app.metadataCache.getCache(state.state.file);
              
              if (cache?.frontmatter && cache.frontmatter[FRONTMATTER_KEY]) {
                // If we have it, force the view type to excalidraw
                const newState = {
                  ...state,
                  type: VIEW_TYPE_EXCALIDRAW,
                };

                self.excalidrawFileModes[state.state.file] = VIEW_TYPE_EXCALIDRAW;

                return next.apply(this, [newState, ...rest]);
              }
            }

            return next.apply(this, [state, ...rest]);
          };
        },
      })
    );

    // Add a menu item to go back to Excalidraw view
    this.register(
      around(MarkdownView.prototype, {
        onMoreOptionsMenu(next) {
          return function (menu: Menu) {
            const file = this.file;
            const cache = file
              ? self.app.metadataCache.getFileCache(file)
              : null;

            if (
              !file ||
              !cache?.frontmatter ||
              !cache.frontmatter[FRONTMATTER_KEY]
            ) {
              return next.call(this, menu);
            }

            menu
              .addItem((item) => {
                item
                  .setTitle(t("OPEN_AS_EXCALIDRAW"))
                  .setIcon(ICON_NAME)
                  .onClick(() => {
                    self.excalidrawFileModes[this.leaf.id || file.path] =
                    VIEW_TYPE_EXCALIDRAW;
                    self.setExcalidrawView(this.leaf);
                  });
              })
              .addSeparator();

            next.call(this, menu);
          };
        },
      })
    );
  }

  private registerEventListeners() {
    const self = this;
    this.app.workspace.onLayoutReady(async () => {



      //watch filename change to rename .svg, .png; to sync to .md; to update links
      const renameEventHandler = async (file:TAbstractFile,oldPath:string) => {
        if(!(file instanceof TFile)) return;
        if(!self.isExcalidrawFile(file)) return;
        if(!self.settings.keepInSync) return;
        ['.svg','.png','.excalidraw'].forEach(async (ext:string)=>{
          const oldIMGpath = getIMGPathFromExcalidrawFile(oldPath,ext);
          const imgFile = self.app.vault.getAbstractFileByPath(normalizePath(oldIMGpath));
          if(imgFile && imgFile instanceof TFile) {
            const newIMGpath = getIMGPathFromExcalidrawFile(file.path,ext);
            await self.app.vault.rename(imgFile,newIMGpath); 
          }
        });
      };
      self.registerEvent(
        self.app.vault.on("rename",renameEventHandler)
      );

      const modifyEventHandler = async (file:TFile) => {
        const leaves = self.app.workspace.getLeavesOfType(VIEW_TYPE_EXCALIDRAW);
        leaves.forEach((leaf:WorkspaceLeaf)=> {
          const excalidrawView = (leaf.view as ExcalidrawView); 
          if(excalidrawView.file 
             && (excalidrawView.file.path == file.path 
                 || (file.extension=="excalidraw" 
                     && file.path.substring(0,file.path.lastIndexOf('.excalidraw'))+'.md' == excalidrawView.file.path))) {
            excalidrawView.reload(true,excalidrawView.file);
          }
        });
      }
      self.registerEvent(
        self.app.vault.on("modify",modifyEventHandler)
      )

      //watch file delete and delete corresponding .svg and .png
      const deleteEventHandler = async (file:TFile) => {
        if (!(file instanceof TFile)) return;     
        //@ts-ignore
        const isExcalidarwFile = (file.unsafeCachedData && file.unsafeCachedData.search(/---\n[\s\S]*excalidraw-plugin:\s*(locked|unlocked)\n[\s\S]*---/gm)>-1) 
                                 || (file.extension=="excalidraw");
        if(!isExcalidarwFile) return;

        //close excalidraw view where this file is open
        const leaves = self.app.workspace.getLeavesOfType(VIEW_TYPE_EXCALIDRAW);
        for (let i=0;i<leaves.length;i++) {
          if((leaves[i].view as ExcalidrawView).file.path == file.path) {
            await leaves[i].setViewState({type: VIEW_TYPE_EXCALIDRAW, state: {file: null}});
          }
        }   

        //delete PNG and SVG files as well
        if (self.settings.keepInSync) {
          ['.svg','.png','.excalidraw'].forEach(async (ext:string) => {
            const imgPath = getIMGPathFromExcalidrawFile(file.path,ext);
            const imgFile = self.app.vault.getAbstractFileByPath(normalizePath(imgPath));
            if(imgFile && imgFile instanceof TFile) {
              await self.app.vault.delete(imgFile); 
            }
          });
        }
      }
      self.registerEvent(
        self.app.vault.on("delete",deleteEventHandler)
      );

      //save open drawings when user quits the application
      const quitEventHandler = (tasks: Tasks) => {
        const leaves = self.app.workspace.getLeavesOfType(VIEW_TYPE_EXCALIDRAW);      
        for (let i=0;i<leaves.length;i++) {
          (leaves[i].view as ExcalidrawView).save(); 
        }
        this.settings.drawingOpenCount += this.opencount;
        this.settings.loadCount++;
        //this.saveSettings();
      }
      self.registerEvent(
        self.app.workspace.on("quit",quitEventHandler)
      );

      //save Excalidraw leaf and update embeds when switching to another leaf
      const activeLeafChangeEventHandler = async (leaf:WorkspaceLeaf) => {
        const activeExcalidrawView = self.activeExcalidrawView;
        const newActiveview:ExcalidrawView = (leaf.view instanceof ExcalidrawView) ? leaf.view as ExcalidrawView : null;
        if(activeExcalidrawView && activeExcalidrawView != newActiveview) {
          await activeExcalidrawView.save(false);
          if(activeExcalidrawView.file) {
            self.triggerEmbedUpdates(activeExcalidrawView.file.path);
          }
        }
        self.activeExcalidrawView = newActiveview;
        if(newActiveview) {
          self.lastActiveExcalidrawFilePath = newActiveview.file?.path;
        }
      };
      self.registerEvent(
        self.app.workspace.on("active-leaf-change",activeLeafChangeEventHandler)
      );
    });
  }

  onunload() {
    destroyExcalidrawAutomate();
    this.observer.disconnect();
    if (this.fileExplorerObserver) this.fileExplorerObserver.disconnect();
    const excalidrawLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EXCALIDRAW);
    excalidrawLeaves.forEach((leaf) => {
      this.setMarkdownView(leaf);
    });
    this.settings.drawingOpenCount += this.opencount;
    this.settings.loadCount++;
    //this.saveSettings();
  }

  public embedDrawing(data:string) {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if(activeView) {
      const editor = activeView.editor;
      editor.replaceSelection("![["+data+"]]");
      editor.focus();
    }
  
  }

  public async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  public getStencilLibrary():string {
    return this.settings.library;
  }

  public setStencilLibrary(library:string) {
      this.settings.library = library;
  }

  public triggerEmbedUpdates(filepath?:string){
    const e = document.createEvent("Event")
    e.initEvent(RERENDER_EVENT,true,false);
    document
      .querySelectorAll("div[class^='excalidraw-svg']"+ (filepath ? "[src='"+filepath.replaceAll("'","\\'")+"']" : ""))
      .forEach((el) => el.dispatchEvent(e));
  }

  public openDrawing(drawingFile: TFile, onNewPane: boolean) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EXCALIDRAW);
    let leaf:WorkspaceLeaf = null;

    if (leaves?.length > 0) {
      leaf = leaves[0];
    }
    if(!leaf) {
      leaf = this.app.workspace.activeLeaf;
    }

    if(!leaf) {
      leaf = this.app.workspace.getLeaf();
    }
    
    if(onNewPane) {
      leaf = this.app.workspace.createLeafBySplit(leaf);
    }    

    leaf.setViewState({
      type: VIEW_TYPE_EXCALIDRAW,
      state: {file: drawingFile.path}}
    );
  }

  private getNextDefaultFilename():string {
    return this.settings.drawingFilenamePrefix + window.moment().format(this.settings.drawingFilenameDateTime)
           + (this.settings.compatibilityMode ? '.excalidraw' : '.excalidraw.md');
  }
 

  private async getBlankDrawing():Promise<string> {
    const template = this.app.metadataCache.getFirstLinkpathDest(normalizePath(this.settings.templateFilePath),"");
    if(template && template instanceof TFile) {
      if(   (template.extension == "md" && !this.settings.compatibilityMode)
         || (template.extension == "excalidraw" && this.settings.compatibilityMode)) {
        const data = await this.app.vault.read(template);
        if (data) return data;
      }
    }
    if (this.settings.compatibilityMode) {
      return BLANK_DRAWING;
    }
    return FRONTMATTER + '\n# Drawing\n'
           + String.fromCharCode(96)+String.fromCharCode(96)+String.fromCharCode(96)+'json\n' 
           + BLANK_DRAWING + '\n'
           + String.fromCharCode(96)+String.fromCharCode(96)+String.fromCharCode(96);
  }

  public async createDrawing(filename: string, onNewPane: boolean, foldername?: string, initData?:string) {
    const folderpath = normalizePath(foldername ? foldername: this.settings.folder);
    await checkAndCreateFolder(this.app.vault,folderpath); //create folder if it does not exist

    const fname = getNewUniqueFilepath(this.app.vault,filename,folderpath);

    if(initData) {
      this.openDrawing(await this.app.vault.create(fname,initData),onNewPane);
      return;
    }

    this.openDrawing(await this.app.vault.create(fname,await this.getBlankDrawing()), onNewPane);
  }

  public async setMarkdownView(leaf: WorkspaceLeaf) {
    await leaf.setViewState(
      {
        type: "markdown",
        state: leaf.view.getState(),
        popstate: true,
      } as ViewState,
      { focus: true }
    );
  }

  private async setExcalidrawView(leaf: WorkspaceLeaf) {
    await leaf.setViewState({
      type: VIEW_TYPE_EXCALIDRAW,
      state: leaf.view.getState(),
      popstate: true,
    } as ViewState);
  }

  isExcalidrawFile(f:TFile) {
    if(f.extension=="excalidraw") return true;
    const fileCache = this.app.metadataCache.getFileCache(f);
    return !!fileCache?.frontmatter && !!fileCache.frontmatter[FRONTMATTER_KEY];
  }

}
