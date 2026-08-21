const path = require('path');
const fs = require('fs');

// Name shown in OBS under Scene Collection. OBS matches --collection and
// global.ini against this name, NOT against the file name, so the "name" field
// inside the collection JSON must be kept in sync with it.
const SCENE_COLLECTION_NAME = 'OBS-MAIN-LED';

// Collection file our app used to write before it set a distinct name. It ended
// up listed as a duplicate "Sans nom" collection and was never loaded.
const LEGACY_COLLECTION_FILE = 'obs-scene-collection.json';

const OBS_CONFIG_DIR = path.join(__dirname, '..', 'provider', 'obs', 'config', 'obs-studio');
const SCENES_DIR = path.join(OBS_CONFIG_DIR, 'basic', 'scenes');
const GLOBAL_INI = path.join(OBS_CONFIG_DIR, 'global.ini');
const WEBSOCKET_CONFIG = path.join(OBS_CONFIG_DIR, 'plugin_config', 'obs-websocket', 'config.json');

// Copy data/obs-scene-collection.json into OBS's portable config, renaming the
// collection so OBS can actually select it.
function installSceneCollection() {
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

    fs.mkdirSync(SCENES_DIR, { recursive: true });
    fs.writeFileSync(
        path.join(SCENES_DIR, `${SCENE_COLLECTION_NAME}.json`),
        JSON.stringify(collection, null, 4),
        'utf8'
    );

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

    console.log(`Scene collection installed as "${SCENE_COLLECTION_NAME}"`);
    return { success: true };
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

        const updated = updateIniSection(body, 'Basic', updates);
        fs.writeFileSync(GLOBAL_INI, (hasBom ? '﻿' : '') + updated, 'utf8');

        console.log(`global.ini now selects scene collection "${SCENE_COLLECTION_NAME}"`);
        return { success: true };
    } catch (error) {
        return { success: false, error: `Could not update global.ini: ${error.message}` };
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
    configureWebSocketServer,
    updateIniSection
};
