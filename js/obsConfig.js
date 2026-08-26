const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { scanDirectory } = require('./videoLibrary');

// Name shown in OBS under Scene Collection. OBS matches --collection and
// global.ini against this name, NOT against the file name, so the "name" field
// inside the collection JSON must be kept in sync with it.
const SCENE_COLLECTION_NAME = 'OBS-MAIN-LED';

// Collection file our app used to write before it set a distinct name. It ended
// up listed as a duplicate "Sans nom" collection and was never loaded.
const LEGACY_COLLECTION_FILE = 'obs-scene-collection.json';

const OBS_CONFIG_DIR = path.join(__dirname, '..', 'provider', 'obs', 'config', 'obs-studio');
const SCENES_DIR = path.join(OBS_CONFIG_DIR, 'basic', 'scenes');
const PROFILES_DIR = path.join(OBS_CONFIG_DIR, 'basic', 'profiles');
const GLOBAL_INI = path.join(OBS_CONFIG_DIR, 'global.ini');
const WEBSOCKET_CONFIG = path.join(OBS_CONFIG_DIR, 'plugin_config', 'obs-websocket', 'config.json');

// The LED board canvas. Every scene item transform written by this module and
// by obsManager assumes this exact size.
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

// Fallbacks used when the template ships without a single media source or
// LOOP_IND item to clone. Mirrors the shape of the items in
// data/obs-scene-collection.json and of what syncLoopScene() creates live.
const MEDIA_SOURCE_TEMPLATE = {
    prev_ver: 520159234,
    name: '',
    uuid: '',
    id: 'ffmpeg_source',
    versioned_id: 'ffmpeg_source',
    settings: {},
    mixers: 255,
    sync: 0,
    flags: 0,
    volume: 1,
    balance: 0.5,
    enabled: true,
    muted: false,
    'push-to-mute': false,
    'push-to-mute-delay': 0,
    'push-to-talk': false,
    'push-to-talk-delay': 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {}
};

const LOOP_ITEM_TEMPLATE = {
    name: '',
    source_uuid: '',
    visible: false,
    locked: false,
    rot: 0,
    align: 5,
    bounds_type: 2, // OBS_BOUNDS_SCALE_INNER
    bounds_align: 0,
    bounds_crop: false,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    id: 0,
    group_item_backup: false,
    pos: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    bounds: { x: 1920, y: 1080 },
    scale_filter: 'disable',
    blend_method: 'default',
    blend_type: 'normal',
    show_transition: { duration: 0 },
    hide_transition: { duration: 0 },
    private_settings: {}
};

// Mirror the media folder into the collection's LOOP_IND scene, in place. This
// is the offline counterpart of obsManager.syncLoopScene(): same source kind,
// same scale-inner 1920x1080 transform, hidden until the automation shows it,
// close_when_inactive so OBS releases the file handles - but applied to the
// collection JSON instead of to a running OBS.
function rebuildLoopScene(collection, videoDirectory) {
    const loopScene = (collection.sources || []).find(
        s => s.id === 'scene' && s.name === 'LOOP_IND');
    if (!loopScene || !loopScene.settings) {
        return { success: false, error: 'LOOP_IND scene missing from the collection' };
    }

    const scan = scanDirectory(videoDirectory);
    const files = scan.exists ? scan.playable : [];

    // ffmpeg_source entries are only ever referenced by LOOP_IND, so the whole
    // set can be regenerated from the folder contents.
    const sourceProto = collection.sources.find(s => s.id === 'ffmpeg_source')
        || MEDIA_SOURCE_TEMPLATE;
    const itemProto = (loopScene.settings.items || [])[0] || LOOP_ITEM_TEMPLATE;

    collection.sources = collection.sources.filter(s => s.id !== 'ffmpeg_source');

    const items = [];
    files.forEach((file, index) => {
        const uuid = crypto.randomUUID();

        const source = JSON.parse(JSON.stringify(sourceProto));
        source.name = file.name;
        source.uuid = uuid;
        source.settings = {
            local_file: file.path.replace(/\\/g, '/'),
            close_when_inactive: true
        };
        collection.sources.push(source);

        const item = JSON.parse(JSON.stringify(itemProto));
        item.name = file.name;
        item.source_uuid = uuid;
        item.visible = false;
        item.id = index + 1;
        // "Adapter à l'écran" whatever the cloned item had: a clip moved or
        // resized by hand in OBS must not become the template applied to the
        // whole folder.
        item.rot = 0;
        item.align = 5;
        item.bounds_type = 2; // OBS_BOUNDS_SCALE_INNER
        item.bounds_align = 0;
        item.pos = { x: 0, y: 0 };
        item.scale = { x: 1, y: 1 };
        item.bounds = { x: CANVAS_WIDTH, y: CANVAS_HEIGHT };
        items.push(item);
    });

    loopScene.settings.items = items;
    loopScene.settings.id_counter = items.length + 1;

    return { success: true, fileCount: items.length, directoryExists: scan.exists };
}

// Names of the media items an installed collection currently holds, for
// reporting what an install changed. Unreadable or absent file: empty list.
function readLoopItemNames(collectionPath) {
    try {
        const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
        const loop = (collection.sources || []).find(
            s => s.id === 'scene' && s.name === 'LOOP_IND');
        return ((loop && loop.settings && loop.settings.items) || []).map(i => i.name);
    } catch (error) {
        return [];
    }
}

// Copy data/obs-scene-collection.json into OBS's portable config, renaming the
// collection so OBS can actually select it. LOOP_IND is rebuilt from the media
// folder on the way, so OBS always opens on sources that exist on disk - this
// doubles as the offline sync when OBS is not running.
function installSceneCollection(videoDirectory) {
    const sourcePath = path.join(__dirname, '..', 'data', 'obs-scene-collection.json');

    if (!fs.existsSync(sourcePath)) {
        return { success: false, error: 'data/obs-scene-collection.json not found' };
    }

    let collection;
    try {
        collection = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    } catch (error) {
        return { success: false, error: `Scene collection is not valid JSON: ${error.message}` };
    }

    collection.name = SCENE_COLLECTION_NAME;

    const rebuilt = rebuildLoopScene(collection, videoDirectory);
    if (!rebuilt.success) {
        return rebuilt;
    }

    const targetPath = path.join(SCENES_DIR, `${SCENE_COLLECTION_NAME}.json`);
    const before = readLoopItemNames(targetPath);

    fs.mkdirSync(SCENES_DIR, { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(collection, null, 4), 'utf8');

    // Drop the old copy so OBS stops listing a collection we never load
    const legacyPath = path.join(SCENES_DIR, LEGACY_COLLECTION_FILE);
    if (fs.existsSync(legacyPath)) {
        try {
            fs.unlinkSync(legacyPath);
            console.log(`Removed stale scene collection copy: ${LEGACY_COLLECTION_FILE}`);
        } catch (error) {
            console.log(`Warning: could not remove ${LEGACY_COLLECTION_FILE}: ${error.message}`);
        }
    }

    const beforeSet = new Set(before);
    const after = readLoopItemNames(targetPath);
    const afterSet = new Set(after);
    const added = after.filter(name => !beforeSet.has(name));
    const removed = before.filter(name => !afterSet.has(name));
    const kept = after.length - added.length;

    console.log(`Scene collection installed as "${SCENE_COLLECTION_NAME}": `
        + `${after.length} media source(s) (+${added.length} -${removed.length})`);
    return { success: true, added, removed, kept, fileCount: rebuilt.fileCount };
}

// Update keys inside one INI section, leaving every other line untouched.
// global.ini holds window geometry and dock layout, so it must not be rewritten
// wholesale.
function updateIniSection(iniText, section, updates) {
    const eol = iniText.includes('\r\n') ? '\r\n' : '\n';
    const lines = iniText.split(/\r?\n/);
    const remaining = { ...updates };

    let sectionStart = -1;
    let sectionEnd = lines.length;
    let current = null;

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].trim().match(/^\[(.+)\]$/);
        if (!match) continue;

        if (current === section) {
            sectionEnd = i;
            break;
        }
        current = match[1];
        if (current === section) {
            sectionStart = i;
        }
    }

    if (sectionStart === -1) {
        // Section absent: append it
        const block = [`[${section}]`, ...Object.entries(updates).map(([k, v]) => `${k}=${v}`)];
        const needsBlank = lines.length && lines[lines.length - 1].trim() !== '';
        return lines.concat(needsBlank ? [''] : [], block, ['']).join(eol);
    }

    for (let i = sectionStart + 1; i < sectionEnd; i++) {
        const key = lines[i].split('=')[0].trim();
        if (Object.prototype.hasOwnProperty.call(remaining, key)) {
            lines[i] = `${key}=${remaining[key]}`;
            delete remaining[key];
        }
    }

    // Keys the section did not have yet
    const missing = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
    if (missing.length) {
        lines.splice(sectionEnd, 0, ...missing);
    }

    return lines.join(eol);
}

// OBS drops a zero-byte "safe_mode" sentinel at startup and removes it on a
// clean exit. If it survives, the next launch opens a modal offering safe mode,
// which disables WebSockets entirely - the app could then never connect. Clear
// it so an unattended launch is never blocked by that prompt.
function clearSafeModeSentinel() {
    const sentinel = path.join(OBS_CONFIG_DIR, 'safe_mode');
    try {
        if (fs.existsSync(sentinel)) {
            fs.unlinkSync(sentinel);
            console.log('Cleared stale safe_mode sentinel from a previous unclean shutdown');
            return { success: true, cleared: true };
        }
        return { success: true, cleared: false };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Tell OBS which scene collection to open. Passing --collection alone is not
// enough on a profile that already has a different collection selected.
function selectSceneCollection() {
    try {
        const updates = {
            SceneCollection: SCENE_COLLECTION_NAME,
            SceneCollectionFile: SCENE_COLLECTION_NAME
        };

        if (!fs.existsSync(GLOBAL_INI)) {
            fs.mkdirSync(OBS_CONFIG_DIR, { recursive: true });
            const block = ['[Basic]', ...Object.entries(updates).map(([k, v]) => `${k}=${v}`), ''];
            fs.writeFileSync(GLOBAL_INI, block.join('\r\n'), 'utf8');
            return { success: true };
        }

        const original = fs.readFileSync(GLOBAL_INI, 'utf8');

        // global.ini is written with a BOM; strip it for parsing and restore it
        const hasBom = original.charCodeAt(0) === 0xfeff;
        const body = hasBom ? original.slice(1) : original;

        let updated = updateIniSection(body, 'Basic', updates);

        // The app closes OBS on quit; an "are you sure?" modal would hang that
        // shutdown and leave the safe_mode sentinel behind.
        updated = updateIniSection(updated, 'General', { ConfirmOnExit: 'false' });

        // Studio Mode is not used. OBS persists the toggle in this key, so a
        // config carrying it from an older version must be flipped back off.
        updated = updateIniSection(updated, 'BasicWindow', { PreviewProgramMode: 'false' });

        fs.writeFileSync(GLOBAL_INI, (hasBom ? '﻿' : '') + updated, 'utf8');

        console.log(`global.ini now selects scene collection "${SCENE_COLLECTION_NAME}"`);
        return { success: true };
    } catch (error) {
        return { success: false, error: `Could not update global.ini: ${error.message}` };
    }
}

// Force the active profile's base (canvas) and output resolutions to the LED
// board's 1920x1080. A profile without a [Video] section makes OBS default the
// canvas to the monitor's resolution, which breaks every "fit to screen"
// transform in the collection.
function configureVideoCanvas() {
    try {
        let profileDir = 'Sans nom';
        if (fs.existsSync(GLOBAL_INI)) {
            const match = fs.readFileSync(GLOBAL_INI, 'utf8').match(/^ProfileDir=(.+)$/m);
            if (match) {
                profileDir = match[1].trim();
            }
        }

        const basicIni = path.join(PROFILES_DIR, profileDir, 'basic.ini');
        const updates = {
            BaseCX: CANVAS_WIDTH,
            BaseCY: CANVAS_HEIGHT,
            OutputCX: CANVAS_WIDTH,
            OutputCY: CANVAS_HEIGHT
        };

        if (!fs.existsSync(basicIni)) {
            fs.mkdirSync(path.dirname(basicIni), { recursive: true });
            const block = [
                '[General]',
                `Name=${profileDir}`,
                '',
                '[Video]',
                ...Object.entries(updates).map(([k, v]) => `${k}=${v}`),
                ''
            ];
            fs.writeFileSync(basicIni, block.join('\r\n'), 'utf8');
        } else {
            const original = fs.readFileSync(basicIni, 'utf8');
            const hasBom = original.charCodeAt(0) === 0xfeff;
            const body = hasBom ? original.slice(1) : original;
            const updated = updateIniSection(body, 'Video', updates);
            fs.writeFileSync(basicIni, (hasBom ? '﻿' : '') + updated, 'utf8');
        }

        console.log(`Profile "${profileDir}" canvas set to ${CANVAS_WIDTH}x${CANVAS_HEIGHT}`);
        return { success: true };
    } catch (error) {
        return { success: false, error: `Could not set the canvas resolution: ${error.message}` };
    }
}

// Pre-configure obs-websocket so the user does not have to enable the server by
// hand. OBS generates a random password on first run and leaves the server off.
function configureWebSocketServer(port, password) {
    try {
        fs.mkdirSync(path.dirname(WEBSOCKET_CONFIG), { recursive: true });

        let config = {
            alerts_enabled: false,
            first_load: false
        };

        if (fs.existsSync(WEBSOCKET_CONFIG)) {
            try {
                config = { ...config, ...JSON.parse(fs.readFileSync(WEBSOCKET_CONFIG, 'utf8')) };
            } catch (error) {
                console.log(`Warning: obs-websocket config unreadable, rewriting it: ${error.message}`);
            }
        }

        config.server_enabled = true;
        config.server_port = port;
        config.server_password = password;
        config.auth_required = Boolean(password);
        config.first_load = false;

        fs.writeFileSync(WEBSOCKET_CONFIG, JSON.stringify(config, null, 2), 'utf8');
        console.log(`obs-websocket configured: port ${port}, auth ${config.auth_required ? 'on' : 'off'}`);
        return { success: true };
    } catch (error) {
        return { success: false, error: `Could not configure obs-websocket: ${error.message}` };
    }
}

module.exports = {
    SCENE_COLLECTION_NAME,
    installSceneCollection,
    selectSceneCollection,
    configureVideoCanvas,
    clearSafeModeSentinel,
    configureWebSocketServer,
    updateIniSection
};
