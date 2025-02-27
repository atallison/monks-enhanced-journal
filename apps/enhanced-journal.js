import { makeid } from "../monks-enhanced-journal.js";
import { MonksEnhancedJournal, log, i18n, error, setting } from "../monks-enhanced-journal.js"
import { EnhancedJournalSheet } from "../sheets/EnhancedJournalSheet.js"
import { JournalEntrySheet } from "../sheets/JournalEntrySheet.js"
import { SelectPlayer } from "./selectplayer.js";

export class EnhancedJournal extends Application {
    tabs = [];
    bookmarks = [];
    searchresults = [];
    searchpos = 0;
    lastquery = '';
    _imgcontext = null;

    constructor(object, options = {}) {
        super(options);

        this.tabs = duplicate(game.user.getFlag('monks-enhanced-journal', 'tabs') || [{ "id": makeid(), "text": i18n("MonksEnhancedJournal.NewTab"), "active": true, "history": [] }]);
        this.tabs.active = (findone = true) => {
            let tab = this.tabs.find(t => t.active);
            if (findone) {
                if (tab == undefined && this.tabs.length > 0)
                    tab = this.tabs[0];
            }
            return tab;
        };
        this.bookmarks = duplicate(game.user.getFlag('monks-enhanced-journal', 'bookmarks') || []);

        this._tabs;// = new Tabs({ navSelector: ".tabs", contentSelector: ".sheet-body", initial: null, callback: this.tabChange });

        this._collapsed = setting('start-collapsed');

        this.subdocument = null;

        this._lastentry = null;
        this._backgroundsound = {};

        //load up the last entry being shown
        this.object = object;
        if (object != undefined)
            this.open(object, null, { anchor: options?.anchor });

        this._soundHook = Hooks.on("globalInterfaceVolumeChanged", (volume) => {
            for (let sound of Object.values(this._backgroundsound)) {
                sound.volume = volume * game.settings.get("core", "globalInterfaceVolume")
            }
        });
    }

    static get defaultOptions() {
        let classes = ["monks-enhanced-journal", `${game.system.id}`];
        if (game.modules.get("rippers-ui")?.active)
            classes.push('rippers-ui');
        if (game.modules.get("rpg-styled-ui")?.active)
            classes.push('rpg-styled-ui');
        if (!setting("show-bookmarkbar"))
            classes.push('hide-bookmark');
        return mergeObject(super.defaultOptions, {
            id: "MonksEnhancedJournal",
            template: "modules/monks-enhanced-journal/templates/main.html",
            title: i18n("MonksEnhancedJournal.Title"),
            classes: classes, //"sheet", "journal-sheet", 
            popOut: true,
            width: 1025,
            height: 700,
            resizable: true,
            editable: true,
            dragDrop: [{ dragSelector: ".journal-tab", dropSelector: "null" }],
            closeOnSubmit: false,
            submitOnClose: false,
            submitOnChange: true,
            viewPermission: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
            scrollY: ["ol.directory-list"]
        });
    }

    get isEditable() {
        let editable = !!this.options["editable"] && this.object.isOwner;
        if (this.object.pack) {
            const pack = game.packs.get(this.object.pack);
            if (pack.locked) editable = false;
        }
        return editable;
    }

    getData(options) {
        //const cfg = CONFIG["JournalEntry"];
        let canBack = this.canBack();
        let canForward = this.canForward();

        return mergeObject(super.getData(options),
            {
                tabs: this.tabs,
                bookmarks: this.bookmarks,
                user: game.user,
                canForward: canForward,
                canBack: canBack,
                collapsed: this._collapsed
            }, {recursive: false}
        );
    }

    //checkForChanges() {
    //    return this.subsheet?.editors?.content?.active && this.subsheet.editors?.content?.mce?.isDirty();
    //}

    async _render(force, options = {}) {
        let result = await super._render(force, options);

        if (this.element) {
            this.renderDirectory().then((html) => {
                MonksEnhancedJournal.updateDirectory(html, false);
            })

            this.renderSubSheet(options).then(() => {
                if (options?.anchor) {
                    const anchor = $(`#${options?.anchor}`, this.element);
                    if (anchor.length) {
                        anchor[0].scrollIntoView();
                    }
                }
            });
        }

        return result;
    }

    async renderDirectory() {
        const cfg = CONFIG["JournalEntry"];
        let template = "modules/monks-enhanced-journal/templates/directory.html";
        let data = {
            tree: ui.journal.tree,
            canCreate: cfg.documentClass.canUserCreate(game.user),
            sidebarIcon: cfg.sidebarIcon,
            user: game.user,
            label: i18n("MonksEnhancedJournal.Entry"),
            labelPlural: i18n("MonksEnhancedJournal.JournalEntries")
        };

        let html = await renderTemplate(template, data);
        html = $(html);

        $('.directory-sidebar', this.element).empty().append(html);

        //if (game.modules.get("forien-quest-log")?.active && !game.settings.get("forien-quest-log", 'showFolder')) {
        let folder = game.journal.directory.folders.find(f => (f.name == '_fql_quests' && f.parent == null));
        if (folder) {
            let elem = html.find(`.folder[data-folder-id="${folder.id}"]`);
            elem.remove();
        }
        //}

        folder = game.journal.directory.folders.find(f => (f.name == '_simple_calendar_notes_directory' && f.parent == null));
        if (folder) {
            let elem = html.find(`.folder[data-folder-id="${folder.id}"]`);
            elem.remove();
        }

        this.activateDirectoryListeners(html);

        this._restoreScrollPositions(html);

        return html;
    }

    async renderSubSheet(options) {
        try {
            let currentTab = this.tabs.active();
            if (!currentTab.entity)
                currentTab.entity = await this.findEntity(currentTab.entityId);
            if (this.object?.id != currentTab.entity?.id || currentTab.entity instanceof Promise || currentTab.entity?.id == undefined)
                this.object = currentTab.entity;

            //if there's no object then show the default
            if (this.object instanceof Promise)
                this.object = await this.object;

            let contentform = $('.content > section', this.element);

            if (this.object instanceof JournalEntry && this.object.pages.size == 1 && (!!getProperty(this.object.pages.contents[0], "flags.monks-enhanced-journal.type") || !!getProperty(this.object, "flags.monks-enhanced-journal.type"))) {
                let type = getProperty(this.object.pages.contents[0], "flags.monks-enhanced-journal.type") || getProperty(this.object, "flags.monks-enhanced-journal.type");
                if (type == "base" || type == "oldentry") type = "journalentry";
                let types = MonksEnhancedJournal.getDocumentTypes();
                if (types[type]) {
                    this.object = this.object.pages.contents[0];
                    let tab = this.tabs.active();
                    tab.entityId = this.object.uuid;
                    tab.entity = this.object;
                    this.saveTabs();
                }
            }

            MonksEnhancedJournal.fixType(this.object);

            //const cls = (this.object._getSheetClass ? this.object._getSheetClass() : null);
            const cls = (this.object._getSheetClass ? this.object._getSheetClass() : null);
            if (!cls)
                this.subsheet = new EnhancedJournalSheet(this.object);
            else 
                this.subsheet = new cls(this.object, { editable: this.object.isOwner, enhancedjournal: this });   
            
            this.object._sheet = this.subsheet;

            this.subsheet.options.popOut = false;
            this.subsheet._state = this.subsheet.constructor.RENDER_STATES.RENDERING;

            this.activateFooterListeners(this.element);

            if (this.subsheet._getHeaderButtons && this.object.id && !(this.object instanceof JournalEntry)) {
                let buttons = this.subsheet._getHeaderButtons();
                buttons.findSplice(b => b.class == "share-image");
                Hooks.call(`getDocumentSheetHeaderButtons`, this.subsheet, buttons);

                $('> header a.subsheet', this.element).remove();
                let first = true;
                let a;
                for (let btn of buttons) {
                    if ($('> header a.' + btn.class, this.element).length == 0) {   //don't repeat buttons
                        a = $('<a>').addClass(btn.class).addClass('subsheet').toggleClass('first', first)
                            .append($('<i>').addClass(btn.icon))
                            .append(i18n(btn.label))
                            .click(event => {
                                event.preventDefault();
                                btn.onclick.call(this.subsheet, event);
                            }).insertBefore($('> header a.close', this.element));
                        first = false;
                    }
                }
                if (a)
                    a.addClass('last');
            }

            let templateData = await this.subsheet.getData();
            //let defaultOptions = this.subsheet.constructor.defaultOptions;
            await loadTemplates({
                journalEntryPageHeader: "templates/journal/parts/page-header.html",
                journalEntryPageFooter: "templates/journal/parts/page-footer.html"
            });
            let html = await renderTemplate(this.subsheet.template, templateData);

            this.subdocument = $(html).get(0);
            this.subsheet.form = (this.subdocument.tagName == 'FORM' ? this.subdocument : $('form:first', this.subdocument).get(0));
            this.subsheet._element = $(this.subdocument);
            this.subsheet.enhancedjournal = this;
            if (this.subsheet.refresh)
                this.subsheet.refresh();
            else if (this.object instanceof JournalEntry)
                this.subsheet.render();

            $('.window-title', this.element).html((this.subsheet.title || i18n("MonksEnhancedJournal.NewTab")) + ' - ' + i18n("MonksEnhancedJournal.Title"));

            if (this.subsheet._createDocumentIdLink)
                this.subsheet._createDocumentIdLink(this.element)

            $('.content', this.element).attr('entity-type', this.object.type).attr('entity-id', this.object.id);
            let classes = this.subsheet.options.classes.join(' ').replace('monks-enhanced-journal', '')
            if (!(this.subsheet instanceof ActorSheet) && !setting("use-system-tag"))
                classes = classes.replace(game.system.id, '');
            contentform.empty().attr('class', classes).append(this.subdocument); //.concat([`${game.system.id}`]).join(' ')

            if (!this.isEditable) {
                this.subsheet._disableFields(contentform[0]);
            }

            if (this.subsheet._createSecretHandlers) {
                this._secrets = this.subsheet._createSecretHandlers();
                this._secrets.forEach(secret => secret.bind(this.element[0]));
            }

            //connect the tabs to the enhanced journal so that opening the regular document won't try and change tabs on the other window.
            this._tabs = this.subsheet.options.tabs.map(t => {
                t.callback = this.subsheet._onChangeTab.bind(this);
                return new Tabs(t);
            });
            this._tabs.forEach(t => t.bind(this.subdocument));

            //reset the original drag drop
            this._dragDrop = this._createDragDropHandlers();
            this._dragDrop.forEach(d => d.bind(this.element[0]));

            //add the subsheet drag drop
            let subDragDrop = this.subsheet.options.dragDrop.map(d => {
                d.permissions = {
                    dragstart: this._canDragStart.bind(this),
                    drop: this._canDragDrop.bind(this)
                };
                d.callbacks = {
                    dragstart: this._onDragStart.bind(this),
                    dragover: this._onDragOver.bind(this),
                    drop: this._onDrop.bind(this)
                };
                return new DragDrop(d);
            });
            subDragDrop.forEach(d => d.bind(contentform[0]));
            this._dragDrop = this._dragDrop.concat(subDragDrop);

            if (this.subsheet.options.scrollY) {
                this._scrollPositions = this._scrollPositions || {};
                /*
                for (let [k, v] of Object.entries(this.subsheet._scrollPositions || {})) {
                    this._scrollPositions[k] = v || this._scrollPositions[k];
                }*/
                let oldScrollY = this.options.scrollY;
                this.options.scrollY = this.options.scrollY.concat(this.subsheet.options.scrollY);
                this._restoreScrollPositions(contentform);
                this.options.scrollY = oldScrollY;

                this.subsheet._scrollPositions = {};
            }

            this.subsheet.activateListeners($(this.subdocument), this);

            $('button[type="submit"]', $(this.subdocument)).attr('type', 'button').on("click", this.subsheet._onSubmit.bind(this.subsheet))

            if (this.subsheet.updateStyle && this.object.type != 'blank')
                this.subsheet.updateStyle(null, this.subdocument);

            if (game.modules.get("polyglot")?.active && this.subsheet.renderPolyglot)
                this.subsheet.renderPolyglot(this.subdocument);

            let that = this;
            let oldSaveEditor = this.subsheet.saveEditor;
            this.subsheet.saveEditor = function (...args) {
                let result = oldSaveEditor.call(this, ...args);
                that.saveEditor(...args);
                return result;
            }

            let oldActivateEditor = this.subsheet.activateEditor;
            this.subsheet.activateEditor = function (...args) {
                that.activateEditor();
                return oldActivateEditor.call(this, ...args);
            }

            this.object._sheet = null;  // Adding this to prevent Quick Encounters from automatically opening

            if (this.object.type != 'blank')
                Hooks.callAll('renderJournalSheet', this.subsheet, contentform, templateData); //this.object);

            this.object._sheet = this.subsheet;

            //if this entry is different from the last one...
            if (this._lastentry != this.object.id) {
                // end a sound file if it's playing
                for(let [key, sound] of Object.entries(this._backgroundsound)) {
                    sound.fade(0, { duration: 250 }).then(() => {
                        sound?.stop();
                        delete this._backgroundsound[key];
                    });
                }
                // if the new entry has a sound file, that autoplays, then start the sound file playing
                if (this.object.type != "blank") {
                    let sound = this.object.getFlag("monks-enhanced-journal", "sound");
                    if (sound?.audiofile && sound?.autoplay && this.subsheet?.canPlaySound) {
                        this.subsheet._playSound(sound).then((soundfile) => {
                            this._backgroundsound[this.object.id] = soundfile;
                        });
                    }
                }
            }
            
            this._lastentry = this.object.id;

            this.activateControls($('#journal-buttons', this.element).empty());
            

            this.object._sheet = null; //set this to null so that other things can open the sheet
            this.subsheet._state = this.subsheet.constructor.RENDER_STATES.RENDERED;
            
        } catch(err) {
            // display an error rendering the subsheet
            error(err);
        }
    }

    _saveScrollPositions(html) {
        super._saveScrollPositions(html);
        if (this.subsheet && this.subsheet.options.scrollY && this.subsheet.object.id == this.object.id) {   //only save if we're refreshing the sheet
            const selectors = this.subsheet.options.scrollY || [];

            this._scrollPositions = selectors.reduce((pos, sel) => {
                //const el = $(sel, this.subdocument);
                //if (el.length === 1) pos[sel] = Array.from(el).map(el => el[0].scrollTop);
                const el = $(this.subdocument).find(sel);
                pos[sel] = Array.from(el).map(el => el.scrollTop);
                return pos;
            }, (this._scrollPositions || {}));
        }
    }

    _activateEditor(div) {
        return this.subsheet._activateEditor.call(this, div);
    }

    activateEditor() {
        $('.nav-button.edit i', this.element).removeClass('fa-pencil-alt').addClass('fa-download').attr('title', i18n("MonksEnhancedJournal.SaveChanges"));
        $('.nav-button.split', this.element).addClass('disabled');
    }

    saveEditor(name) {
        $('.nav-button.edit i', this.element).addClass('fa-pencil-alt').removeClass('fa-download').attr('title', i18n("MonksEnhancedJournal.EditDescription"));
        $('.nav-button.split', this.element).removeClass('disabled');
        const editor = this.subsheet.editors[name];
        if (editor)
            editor.button.style.display = "";

        const owner = this.object.isOwner;
        (game.system.id == "pf2e" ? game.pf2e.TextEditor : TextEditor).enrichHTML(this.object.content, { secrets: owner, documents: true, async: true }).then((content) => {
            $(`.editor-content[data-edit="${name}"]`, this.element).html(content);
        });
        
    }

    activateControls(html) {
        let ctrls = [];
        if (this.subsheet._documentControls)
            ctrls = this.subsheet._documentControls();
        else if (this.object instanceof JournalEntry) {
            ctrls = this.journalEntryDocumentControls();
         }

        let that = this;

        Hooks.callAll('activateControls', this, ctrls);
        if (ctrls) {
            for (let ctrl of ctrls) {
                if (ctrl.conditional != undefined) {
                    if (typeof ctrl.conditional == 'function') {
                        if (!ctrl.conditional.call(this.subsheet))
                            continue;
                    }
                    else if (!ctrl.conditional)
                        continue;
                }
                let div = '';
                switch (ctrl.type || 'button') {
                    case 'button':
                        div = $('<div>')
                            .addClass('nav-button ' + ctrl.id)
                            .attr('title', ctrl.text)
                            .append($('<i>').addClass('fas ' + ctrl.icon))
                            .on('click', ctrl.callback.bind(this.subsheet));
                        break;
                    case 'input':
                        div = $('<input>')
                            .addClass('nav-input ' + ctrl.id)
                            .attr(mergeObject({ 'type': 'text', 'autocomplete': 'off', 'placeholder': ctrl.text }, (ctrl.attributes || {})))
                            .on('keyup', function (event) {
                                ctrl.callback.call(that.subsheet, this.value, event);
                            });
                        break;
                    case 'text':
                        div = $('<div>').addClass('nav-text ' + ctrl.id).html(ctrl.text);
                        break;
                }

                if (div != '') {
                    if (ctrl.visible === false)
                        div.hide();
                    html.append(div);
                }
            }
        }

        if (this.object instanceof JournalEntry) {
            const modes = JournalSheet.VIEW_MODES;
            $('.viewmode', html).attr("data-action", "toggleView").attr("title", this.subsheet?.mode === modes.SINGLE ? "View Multiple Pages" : "View Single Page").find("i").toggleClass("fa-notes", this.subsheet?.mode === modes.SINGLE).toggleClass("fa-note", this.subsheet?.mode !== modes.SINGLE);

        }
    }

    get getDocumentTypes() {
        return mergeObject(MonksEnhancedJournal.getDocumentTypes(), {
            blank: EnhancedJournalSheet
        });
    }

    get entitytype() {
        if (this.object instanceof Actor)
            return 'actor';

        let flags = this.object?.flags;
        let type = (flags != undefined ? flags['monks-enhanced-journal']?.type : null) || 'oldentry';

        if (this.object?.folder?.name == '_fql_quests')
            type = 'oldentry';

        return type;
    }

    async close(options) {
        if (options?.submit !== false) {
            if (await this?.subsheet?.close() === false)
                return false;
            MonksEnhancedJournal.journal = null;
            // if there's a sound file playing, then close it
            for (let [key, sound] of Object.entries(this._backgroundsound)) {
                sound.stop();
            }

            Hooks.off("globalInterfaceVolumeChanged", this._soundHook);

            return super.close(options);
        }
    }

    tabChange(tab, event) {
        log('tab change', tab, event);
    }

    canBack(tab) {
        if (tab == undefined)
            tab = this.tabs.active();
        if (tab == undefined)
            return false;
        return tab.history?.length > 1 && (tab.historyIdx == undefined || tab.historyIdx < tab.history.length - 1);
    }

    canForward(tab) {
        if (tab == undefined)
            tab = this.tabs.active();
        if (tab == undefined)
            return false;
        return tab.history?.length > 1 && tab.historyIdx && tab.historyIdx > 0;
    }

    async findEntity(entityId, text) {
        if (entityId == undefined)
            return { flags: { 'monks-enhanced-journal': { type: 'blank' } }, text: { content: "" } };
        else {
            let entity;
            if (entityId.indexOf('.') >= 0) {
                try {
                    entity = await fromUuid(entityId);
                } catch (err) { log('Error find entity', entityId, err); }
            } else {
                if (entity == undefined)
                    entity = game.journal.get(entityId);
                if (entity == undefined)
                    entity = game.actors.get(entityId);
            }
            if (entity == undefined)
                entity = { name: text, flags: { 'monks-enhanced-journal': { type: 'blank' }, content: `${i18n("MonksEnhancedJournal.CannotFindEntity")}: ${text}` } };

            return entity;
        }
    }

    async deleteEntity(entityId){
        //an entity has been deleted, what do we do?
        for (let tab of this.tabs) {
            if (tab.entityId?.startsWith(entityId)) {
                tab.entity = await this.findEntity('', tab.text); //I know this will return a blank one, just want to maintain consistency
                tab.text = i18n("MonksEnhancedJournal.NewTab");
                $('.journal-tab[data-tabid="${tab.id}"] .tab-content', this.element).html(tab.text);
            }

            //remove it from the history
            tab.history = tab.history.filter(h => h != entityId);

            if (tab.active && this.rendered)
                this.render(true);  //if this entity was being shown on the active tab, then refresh the journal
        }

        this.saveTabs();
    }

    addTab(entity, options = { activate: true, refresh: true }) {
        if (entity?.currentTarget != undefined)
            entity = null;

        let tab = {
            id: makeid(),
            text: entity?.name || i18n("MonksEnhancedJournal.NewTab"),
            active: false,
            entityId: entity?.uuid,
            entity: entity || { flags: { 'monks-enhanced-journal': { type: 'blank' }, content: i18n("MonksEnhancedJournal.NewTab") } },
            history: []
        };
        if (tab.entityId != undefined)
            tab.history.push(tab.entityId);
        this.tabs.push(tab);

        if (options.activate)
            this.activateTab(tab);  //activating the tab should save it
        else {
            this.saveTabs();
            if (options.refresh)
                this.render(true, { focus: true });
        }

        this.updateRecent(tab.entity);

        return tab;
    }

    async activateTab(tab, event, options) {
        if (await this?.subsheet?.close() === false)
            return false;

        if (tab == undefined)
            tab = this.addTab();

        if (event != undefined)
            event.preventDefault();

        if (tab.currentTarget != undefined) {
            tab.preventDefault();
            tab = tab.currentTarget.dataset.tabid;
        }
        if (typeof tab == 'string')
            tab = this.tabs.find(t => t.id == tab);
        else if (typeof tab == 'number')
            tab = this.tabs[tab];

        let currentTab = this.tabs.active(false);
        if (currentTab?.id != tab.id || this.subdocument == undefined) {
            tab.entity = await this.findEntity(tab.entityId, tab.text);
        }

        /*
        if (currentTab?.id == tab.id) {
            this.display(tab.entity);
            this.updateHistory();
            return false;
        }*/

        if (currentTab != undefined)
            currentTab.active = false;
        tab.active = true;

        this._tabs.active = null;

        //$('.back-button', this.element).toggleClass('disabled', !this.canBack(tab));
        //$('.forward-button', this.element).toggleClass('disabled', !this.canForward(tab));

        //$(`.journal-tab[data-tabid="${tab.id}"]`, this.element).addClass('active').siblings().removeClass('active');

        //this.display(tab.entity);

        this.saveTabs();

        //this.updateHistory();

        this.render(true, options);

        this.updateRecent(tab.entity);

        return true;
    }

    updateTab(tab, entity, options = {}) {
        if (!entity)
            return;

        if (tab != undefined) {
            if (tab.entityId != entity.uuid) {
                tab.text = entity.name;
                tab.entityId = entity.uuid;
                tab.entity = entity;

                if ((game.user.isGM || setting('allow-player')) && tab.entityId != undefined) {    //only save the history if the player is a GM or they get the full journal experience... and if it's not a blank tab
                    if (tab.history == undefined)
                        tab.history = [];
                    if (tab.historyIdx != undefined) {
                        tab.history = tab.history.slice(tab.historyIdx);
                        tab.historyIdx = 0;
                    }
                    tab.history.unshift(tab.entityId);

                    if (tab.history.length > 10)
                        tab.history = tab.history.slice(0, 10);
                }

                this.saveTabs();

                //$(`.journal-tab[data-tabid="${tab.id}"]`, this.element).attr('title', tab.text).find('.tab-content').html(tab.text);
            } else if (tab.entity == undefined) {
                tab.entity = entity;
            }

            //$('.back-button', this.element).toggleClass('disabled', !this.canBack(tab));
            //$('.forward-button', this.element).toggleClass('disabled', !this.canForward(tab));
            //this.updateHistory();
            this.updateRecent(tab.entity);
        }

        if (!this.rendered)
            return;

        this.render(true, mergeObject({ focus: true }, options));
    }

    removeTab(tab, event) {
        if (typeof tab == 'string')
            tab = this.tabs.find(t => t.id == tab);

        let idx = this.tabs.findIndex(t => t.id == tab.id);
        if (idx >= 0) {
            this.tabs.splice(idx, 1);
            $('.journal-tab[data-tabid="' + tab.id + '"]', this.element).remove();
        }

        if (this.tabs.length == 0)
            this.addTab();
        else {
            if (tab.active) {
                let nextIdx = (idx >= this.tabs.length ? idx - 1 : idx);
                if (!this.activateTab(nextIdx))
                    this.saveTabs();
            }
        }

        if (event != undefined)
            event.preventDefault();
    }

    saveTabs() {
        let update = this.tabs.map(t => {
            let entity = t.entity;
            delete t.entity;
            let tab = duplicate(t);
            t.entity = entity;
            delete tab.element;
            delete tab.entity;
            //delete tab.history;  //technically we could save the history if it's just an array of ids
            //delete tab.historyIdx;
            delete tab.userdata;
            return tab;
        });
        game.user.update({
            flags: { 'monks-enhanced-journal': { 'tabs': update } }
        }, { render: false });
    }

    updateTabNames(uuid, name) {
        for (let tab of this.tabs) {
            if (tab.entityId == uuid) {
                $(`.journal-tab[data-tabid="${tab.id}"] .tab-content`, this.element).html(name);
                tab.text = name;
                this.saveTabs();
            }
        }
    }

    navigateFolder(event) {
        let ctrl = event.currentTarget;
        let id = ctrl.dataset.entityId;

        if (id == '')
            return;

        let entity = game.journal.find(j => j.id == id);
        this.open(entity);
    }

    navigateHistory(event) {
        if (!$(event.currentTarget).hasClass('disabled')) {
            let dir = event.currentTarget.dataset.history;
            let tab = this.tabs.active();

            if (tab.history.length > 1) {
                let result = true;
                let idx = 0;
                do {
                    idx = ((tab.historyIdx == undefined ? 0 : tab.historyIdx) + (dir == 'back' ? 1 : -1));
                    result = this.changeHistory(idx);
                } while (!result && idx > 0 && idx < tab.history.length )
            }
        }
        event.preventDefault();
    }

    async changeHistory(idx) {
        let tab = this.tabs.active();
        tab.historyIdx = Math.clamped(idx, 0, (tab.history.length - 1));

        tab.entityId = tab.history[tab.historyIdx];
        tab.entity = await this.findEntity(tab.entityId, tab.text);
        tab.text = tab.entity.name;

        this.saveTabs();

        this.render(true, { autoPage: true } );

        this.updateRecent(tab.entity);

        //$('.back-button', this.element).toggleClass('disabled', !this.canBack(tab));
        //$('.forward-button', this.element).toggleClass('disabled', !this.canForward(tab));

        return (tab?.entity?.id != undefined);
    }

    async getHistory() {
        let index = 0;
        let tab = this.tabs.active();
        let menuItems = [];

        if (tab.history == undefined)
            return;

        for (let i = 0; i < tab.history.length; i++) {
            let h = tab.history[i];
            let entity = await this.findEntity(h, '');
            if (tab?.entity?.id != undefined) {
                let type = (entity.getFlag && entity.getFlag('monks-enhanced-journal', 'type'));
                let icon = MonksEnhancedJournal.getIcon(type);
                let item = {
                    name: entity.name || i18n("MonksEnhancedJournal.Unknown"),
                    icon: `<i class="fas ${icon}"></i>`,
                    callback: (li) => {
                        let idx = i;
                        this.changeHistory(idx)
                    }
                }
                menuItems.push(item);
            }
        };

        return menuItems;
    }

    addBookmark() {
        //get the current tab and save the entity and name
        let tab = this.tabs.active();

        if (tab?.entityId == undefined)
            return;

        if (this.bookmarks.find(b => b.entityId == tab.entityId) != undefined) {
            ui.notifications.warn(i18n("MonksEnhancedJournal.MsgOnlyOneBookmark"));
            return;
        }

        let entitytype = function(entity) {
            if (entity instanceof Actor)
                return 'actor';

            let flags = entity.data?.flags;
            let type = (flags != undefined ? flags['monks-enhanced-journal']?.type : null) || 'journalentry';

            return type;
        }

        let bookmark = {
            id: makeid(),
            entityId: tab.entityId,
            text: tab.entity.name,
            icon: MonksEnhancedJournal.getIcon(entitytype(tab.entity))
        }

        this.bookmarks.push(bookmark);

        $('<div>')
            .addClass('bookmark-button')
            .attr({ title: bookmark.text, 'data-bookmark-id': bookmark.id, 'data-entity-id': bookmark.entityId })
            .html(`<i class="fas ${bookmark.icon}"></i> ${bookmark.text}`)
            .appendTo('.bookmark-bar', this.element).get(0).click(this.activateBookmark.bind(this));

        this.saveBookmarks();
    }

    async activateBookmark(event) {
        let id = event.currentTarget.dataset.bookmarkId;
        let bookmark = this.bookmarks.find(b => b.id == id);
        let entity = await this.findEntity(bookmark.entityId, bookmark.text);
        this.open(entity, setting("open-new-tab"));
    }

    removeBookmark(bookmark) {
        this.bookmarks.findSplice(b => b.id == bookmark.id);
        $(`.bookmark-button[data-bookmark-id="${bookmark.id}"]`, this.element).remove();
        this.saveBookmarks();
    }

    saveBookmarks() {
        let update = this.bookmarks.map(b => {
            let bookmark = duplicate(b);
            return bookmark;
        });
        game.user.setFlag('monks-enhanced-journal', 'bookmarks', update);
    }

    async open(entity, newtab, options) {
        //if there are no tabs, then create one
        this._tabs.active = null;
        if (this.tabs.length == 0) {
            this.addTab(entity);
        } else {
            if (newtab === true) {
                //the journal is getting created
                //lets see if we can find  tab with this entity?
                let tab = this.tabs.find(t => t.entityId.endsWith(entity.id));
                if (tab != undefined)
                    this.activateTab(tab, null, options);
                else
                    this.addTab(entity);
            } else {
                if (await this?.subsheet?.close() !== false)
                    //this.addTab(entity, { activate: false, refresh: false }); //If we're editing, then open in a new tab but don't activate
                //else
                    this.updateTab(this.tabs.active(), entity, options);
            }
        }
    }

    async updateRecent(entity) {
        if (entity.id) {
            let recent = game.user.getFlag("monks-enhanced-journal", "_recentlyViewed") || [];
            recent.findSplice(e => e.id == entity.id || typeof e != 'object');
            recent.unshift({ id: entity.id, uuid: entity.uuid, name: entity.name, type: entity.getFlag("monks-enhanced-journal", "type") });
            if (recent.length > 5)
                recent = recent.slice(0, 5);
            await game.user.update({
                flags: { 'monks-enhanced-journal': { '_recentlyViewed': recent } }
            }, { render: false });
        }
    }

    expandSidebar() {
        this._collapsed = false;
        $('.monks-enhanced-journal', this.element).removeClass('collapse');
        $('.sidebar-toggle i', this.element).removeClass('fa-caret-left').addClass('fa-caret-right');
    }

    collapseSidebar() {
        this._collapsed = true;
        $('.monks-enhanced-journal', this.element).addClass('collapse');
        $('.sidebar-toggle i', this.element).removeClass('fa-caret-right').addClass('fa-caret-left');
    }

    _randomizePerson() {
        //randomize first name, last name, race, gender, profession
        //check first to see if the field needs to be rendomized, or if the fields are filled in
    }

    searchText(query) {
        let that = this;
        $('.editor .editor-content', this.element).unmark().mark(query, {
            wildcards: 'enabled',
            accuracy: "complementary",
            separateWordSearch: false,
            noMatch: function () {
                if (query != '')
                    $('.mainbar .navigation .search', that.element).addClass('error');
            },
            done: function (total) {
                if (query == '')
                    $('.mainbar .navigation .search', that.element).removeClass('error');
                if (total > 0) {
                    $('.mainbar .navigation .search', that.element).removeClass('error');
                    let first = $('.editor .editor-content mark:first', that.element);
                    $('.editor', that.element).parent().scrollTop(first.position().top - 10);
                }
            }
        });
    }

    splitJournal(event) {
        if ($('.nav-button.split i', this.enhancedjournal.element).hasClass('disabled')) {
            ui.notifications.warn(i18n("MonksEnhancedJournal.CannotSplitJournal"));
            return;
        }

        this.splitJournal();
    }

    _canDragStart(selector) {
        if (selector == ".journal-tab") return true;

        if (this.subsheet)
            return this.subsheet._canDragStart(selector);
        else
            return super._canDragStart(selector);
    }

    _canDragDrop(selector) {
        if (this.subsheet)
            return this.subsheet._canDragDrop(selector);
        else
            return super._canDragDrop(selector);
    }

    _onDragStart(event) {
        const target = event.currentTarget;

        if ($(target).hasClass('journal-tab')) {
            const dragData = { from: this.object.uuid };

            let tabid = target.dataset.tabid;
            let tab = this.tabs.find(t => t.id == tabid);
            dragData.uuid = tab.entityId;
            dragData.type = "JournalTab";

            log('Drag Start', dragData);

            event.dataTransfer.setData("text/plain", JSON.stringify(dragData));
        }else
            return this.subsheet._onDragStart(event);
    }

    _onDrop(event) {
        log('enhanced journal drop', event);
        let result = this.subsheet._onDrop(event);

        if (result === false) {
            let data;
            try {
                data = JSON.parse(event.dataTransfer.getData('text/plain'));
            }
            catch (err) {
                return false;
            }
    
            if (data.type == 'Actor') {
                if (data.pack == undefined) {
                    let actor = game.actors.get(data.id);
                    this.open(actor, setting("open-new-tab"));
                }
            } else if (data.type == 'JournalEntry') {
                let entity = game.journal.get(data.id);
                this.open(entity, setting("open-new-tab"));
            }     
            log('drop data', event, data);
        }

        return result;
    }

    async _updateObject(event, formData) {
        if (this._sheetMode === "image") {
            formData.name = formData.title;
            delete formData["title"];
            formData.img = formData.image;
            delete formData["image"];
        }
        return super._updateObject(event, formData);
    }

    async _onSwapMode(event, mode) {
        //don't do anything, but leave this here to prevent the regular journal page from doing anything
    }

    _getHeaderButtons() {
        let buttons = super._getHeaderButtons();

        buttons.unshift({
            label: i18n("MonksEnhancedJournal.Maximize"),
            class: "toggle-fullscreen",
            icon: "fas fa-expand-arrows-alt",
            onclick: this.fullscreen.bind(this)
        });

        return buttons;
    }

    findMapEntry(event) {
        let mainbar = event.currentTarget.closest('.mainbar');
        let content = $(mainbar).next();
        let id = $(content).attr('entity-id');
        //find this id on the map

        let note = canvas.notes.placeables.find(n => {
            return n.document.entryId == id || n.document.pageId == id;
        });
        canvas.notes.panToNote(note);
    }

    doShowPlayers(event) {
        if (event.shiftKey)
            this._onShowPlayers({ data: { users: null, object: this.object, options: { showpic: false } } });
        else if (event.ctrlKey)
            this._onShowPlayers({ data: { users: null, object: this.object, options: { showpic: true } } });
        else {
            //let type = this.entitytype;
            //new SelectPlayer(this, { showpic: $('.fullscreen-image', this.element).is(':visible') || ((type == 'journalentry' || type == 'oldentry') && $('.tab.picture', this.element).hasClass('active') )}).render(true);
            this._onShowPlayers(event);
        }
    }

    fullscreen() {
        if (this.element.hasClass("maximized")) {
            this.element.removeClass("maximized");
            $('.toggle-fullscreen', this.element).html(`<i class="fas fa-expand-arrows-alt"></i>${i18n("MonksEnhancedJournal.Maximize")}`);
            this.setPosition({ width: this._previousPosition.width, height: this._previousPosition.height });
            this.setPosition({ left: this._previousPosition.left, top: this._previousPosition.top });
        } else {
            this.element.addClass("maximized");
            $('.toggle-fullscreen', this.element).html(`<i class="fas fa-compress-arrows-alt"></i>${i18n("MonksEnhancedJournal.Restore")}`);
            
            this._previousPosition = duplicate(this.position);
            this.setPosition({ left: 0, top: 0 });
            this.setPosition({ height: $('body').height(), width: $('body').width() - $('#sidebar').width() });
        }
    }

    cancelSend(id, showpic) {
        MonksEnhancedJournal.emit("cancelShow", {
            showid: id,
            userId: game.user.id
        });
    }

    _onSelectFile(selection, filePicker, event) {
        log(selection, filePicker, event);
        let updates = {};
        updates[filePicker.field.name] = selection;
        this.object.update(updates);
    }

    async convert(type) {
        this.object._sheet = null;
        MonksEnhancedJournal.fixType(this.object, type);
        await this.object.setFlag('monks-enhanced-journal', 'type', type);
        await ui.sidebar.tabs.journal.render(true)
        //MonksEnhancedJournal.updateDirectory($('#journal'));
    }

    async _contextMenu(html) {
        this._context = new ContextMenu(html, ".bookmark-button", [
            {
                name: "MonksEnhancedJournal.Delete",
                icon: '<i class="fas fa-trash"></i>',
                callback: li => {
                    const bookmark = this.bookmarks.find(b => b.id === li[0].dataset.bookmarkId);
                    this.removeBookmark(bookmark);
                }
            }
        ]);
        let history = await this.getHistory();
        this._tabcontext = new ContextMenu(html, ".mainbar .navigation .nav-button.history", history);
        this._imgcontext = new ContextMenu(html, ".journal-body.oldentry .tab.picture", [
            {
                name: "MonksEnhancedJournal.Delete",
                icon: '<i class="fas fa-trash"></i>',
                callback: li => {
                    log('Remove image on old entry');
                }
            }
        ]);

        this._convertmenu = new ContextMenu(html, ".nav-button.convert", [
            {
                name: i18n("MonksEnhancedJournal.encounter"),
                icon: '<i class="fas fa-toolbox"></i>',
                callback: li => {
                    this.convert('encounter');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.journalentry"),
                icon: '<i class="fas fa-book-open"></i>',
                callback: li => {
                    this.convert('journalentry');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.organization"),
                icon: '<i class="fas fa-flag"></i>',
                callback: li => {
                    this.convert('organization');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.person"),
                icon: '<i class="fas fa-user"></i>',
                callback: li => {
                    this.convert('person');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.picture"),
                icon: '<i class="fas fa-image"></i>',
                callback: li => {
                    this.convert('picture');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.place"),
                icon: '<i class="fas fa-place-of-worship"></i>',
                callback: li => {
                    this.convert('place');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.poi"),
                icon: '<i class="fas fa-map-marker-alt"></i>',
                callback: li => {
                    this.convert('poi');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.quest"),
                icon: '<i class="fas fa-map-signs"></i>',
                callback: li => {
                    this.convert('quest');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.shop"),
                icon: '<i class="fas fa-dolly-flatbed"></i>',
                callback: li => {
                    this.convert('shop');
                }
            },
            {
                name: i18n("MonksEnhancedJournal.loot"),
                icon: '<i class="fas fa-donate"></i>',
                callback: li => {
                    this.convert('loot');
                }
            }
        ], { eventName: 'click' });
    }

    async _onChangeInput(event) {
        return this.subsheet._onChangeInput(event);
    }

    _activateFilePicker(event) {
        return this.subsheet._activateFilePicker(event);
    }

    activateDirectoryListeners(html) {   
        $('.sidebar-toggle', html).on('click', function () {
            if (this._collapsed)
                this.expandSidebar();
            else
                this.collapseSidebar();
        });
        //_onClickPageLink

        ui.journal._contextMenu.call(ui.journal, html);

        const directory = html.find(".directory-list");
        const entries = directory.find(".directory-item");

        // Directory-level events
        html.find('.create-document').click(ev => ui.journal._onCreateDocument(ev));
        html.find('.collapse-all').click(ui.journal.collapseAll.bind(this));
        html.find(".folder .folder .folder .create-folder").remove(); // Prevent excessive folder nesting
        if (game.user.isGM) html.find('.create-folder').click(ev => ui.journal._onCreateFolder(ev));

        // Entry-level events
        directory.on("click", ".document-name", ui.journal._onClickDocumentName.bind(ui.journal));
        directory.on("click", ".folder-header", ui.journal._toggleFolder.bind(this));
        //this._contextMenu(html);

        // Intersection Observer
        const observer = new IntersectionObserver(ui.journal._onLazyLoadImage.bind(this), { root: directory[0] });
        entries.each((i, li) => observer.observe(li));

        this._searchFilters = [new SearchFilter({ inputSelector: 'input[name="search"]', contentSelector: ".directory-list", callback: ui.journal._onSearchFilter.bind(ui.journal) })];
        this._searchFilters.forEach(f => f.bind(html[0]));

        ui.journal._dragDrop.forEach(d => d.bind(html[0]));
    }

    activateListeners(html) {
        super.activateListeners(html);

        this._contextMenu(html);

        $('.sidebar-toggle', html).on('click', $.proxy(function () {
            if (this._collapsed)
                this.expandSidebar();
            else
                this.collapseSidebar();
        }, this));

        html.find('.add-bookmark').click(this.addBookmark.bind(this));
        html.find('.bookmark-button:not(.add-bookmark)').click(this.activateBookmark.bind(this));

        html.find('.tab-add').click(this.addTab.bind(this));
        html.find('.journal-tab').click(this.activateTab.bind(this));

        let that = this;
        $('.journal-tab .close').each(function () {
            let tabid = $(this).closest('.journal-tab')[0].dataset.tabid;
            let tab = that.tabs.find(t => t.id == tabid);
            $(this).click(that.removeTab.bind(that, tab));
        });

        $('.back-button, .forward-button', html).toggle(game.user.isGM || setting('allow-player')).on('click', this.navigateHistory.bind(this));
    }

    activateFooterListeners(html) {
        let folder = (this.object.folder || this.object.parent?.folder);
        let content = folder ? folder.contents : ui.journal.tree.documents;
        let sorting = folder?.sorting || "m";
        let documents = content
            .map(c => {
                if (!c.testUserPermission(game.user, "OBSERVER"))
                    return null;
                return {
                    id: c.id,
                    name: c.name || "",
                    sort: c.sort
                }
            })
            .filter(d => !!d)
            .sort((a, b) => {
                return sorting == "m" ? a.sort - b.sort : a.name.localeCompare(b.name);
            })
        let idx = documents.findIndex(e => e.id == this.object.id || e.id == this.object.parent?.id);

        let prev = (idx > 0 ? documents[idx - 1] : null);
        let next = (idx < documents.length - 1 ? documents[idx + 1] : null);
        $('.navigate-prev', html).toggle(this.object.type !== "blank").toggleClass('disabled', !prev).attr("title", prev?.name).on("click", this.openPage.bind(this, prev));
        $('.navigate-next', html).toggle(this.object.type !== "blank").toggleClass('disabled', !next).attr("title", next?.name).on("click", this.openPage.bind(this, next));

        if (this.object instanceof JournalEntry) {
            $('.page-prev', html).toggleClass("disabled", !this.subsheet || this.subsheet?.pageIndex < 1).show().on("click", this.previousPage.bind(this));
            $('.page-next', html).toggleClass("disabled", !this.subsheet || this.subsheet?.pageIndex >= this.subsheet?._pages.length - 1).show().on("click", this.nextPage.bind(this));
        /*} else if (this.object instanceof JournalEntryPage) {
            let pageIdx = this.object.parent.pages.contents.findIndex(p => p.id == this.object.id);
            let prevPage = (pageIdx > 0 ? this.object.parent.pages.contents[pageIdx - 1] : null);
            let nextPage = (pageIdx < this.object.parent.pages?.contents.length - 1 ? this.object.parent.pages.contents[pageIdx + 1] : null);
            $('.page-prev', html).toggleClass('disabled', !prevPage).toggle(this.object.parent.pages?.contents?.length > 1).attr("title", prevPage?.name).on("click", this.previousPage.bind(this, prevPage));
            $('.page-next', html).toggleClass('disabled', !nextPage).toggle(this.object.parent.pages?.contents?.length > 1).attr("title", nextPage?.name).on("click", this.nextPage.bind(this, nextPage));
        */
        } else {
            $('.page-prev', html).hide();
            $('.page-next', html).hide();
        }

        $('.add-page', html).on("click", this.addPage.bind(this));
        $('.toggle-menu', html).toggle(!(this.object instanceof JournalEntryPage)).on("click", this.toggleMenu.bind(this));
     }

    journalEntryDocumentControls() {
        let ctrls = [
            { text: '<i class="fas fa-search"></i>', type: 'text' },
            { id: 'search', type: 'input', text: "Search Journal", callback: this.searchText },
            { id: 'viewmode', text: "View Single Page", icon: 'fa-notes', callback: this.toggleViewMode },
            { id: 'add', text: "Add a Page", icon: 'fa-file-plus', conditional: game.user.isGM, callback: this.addPage },
            { id: 'show', text: i18n("MonksEnhancedJournal.ShowToPlayers"), icon: 'fa-eye', conditional: game.user.isGM, callback: this.doShowPlayers }
        ];

        return ctrls;
    }

    openPage(page) {
        if (!page?.id)
            return;
        let journal = game.journal.get(page.id);
        if (journal) this.open(journal);
    }

    toggleMenu() {
        if (this.subsheet.toggleSidebar) this.subsheet.toggleSidebar(event);
    }

    toggleViewMode(event) {
        this._onAction(event);
        const modes = JournalSheet.VIEW_MODES;
        $('.viewmode', this.enhancedjournal.element).attr("title", this.mode !== modes.SINGLE ? "View Multiple Pages" : "View Single Page")
            .find("i")
            .toggleClass("fa-notes", this.mode !== modes.SINGLE)
            .toggleClass("fa-note", this.mode === modes.SINGLE);
    }

    journalSettings() {

    }

    addPage() {
        let journal = this.object.parent || this.object;

        const options = { parent: journal };
        return JournalEntryPage.implementation.createDialog({}, options);
    }

    previousPage() {
        if (this.subsheet) {
            if (this.subsheet.previousPage) this.subsheet.previousPage(event);
            $('.page-prev', this.element).toggleClass("disabled", !this.subsheet || this.subsheet?.pageIndex < 1);
            $('.page-next', this.element).toggleClass("disabled", !this.subsheet || this.subsheet?.pageIndex >= this.subsheet?._pages.length - 1);
        }
    }

    nextPage() {
        if (this.subsheet) {
            if (this.subsheet.nextPage) this.subsheet.nextPage(event);
            $('.page-prev', this.element).toggleClass("disabled", !this.subsheet || this.subsheet?.pageIndex < 1);
            $('.page-next', this.element).toggleClass("disabled", !this.subsheet || this.subsheet?.pageIndex >= this.subsheet?._pages.length - 1);
        }
    }
}