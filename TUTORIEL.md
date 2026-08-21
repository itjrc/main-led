# Tutoriel — Démarrer OBS Main LED

Guide pas à pas pour lancer l'application sur une machine Windows neuve.

---

## 1. Prérequis

| Élément | Détail |
|---|---|
| OS | Windows 10 / 11 (64 bits) — le projet est **Windows-only** (chemins `.exe`, scripts PowerShell) |
| PowerShell | 5.1 (fourni avec Windows) ou plus récent |
| Écrans | 2 moniteurs pour la projection plein écran (facultatif, l'app démarre quand même) |
| Réseau | Nécessaire au premier lancement (Node.js ~35 Mo, OBS ~140 Mo, FFmpeg ~80 Mo) |
| Espace disque | ~2 Go (Node + OBS + FFmpeg + vidéos) |

**Node.js n'a pas besoin d'être installé sur le système** : le projet télécharge sa
propre copie portable dans `provider/node/`.

---

## 2. Lancement

Depuis l'Explorateur, double-cliquez sur `start.bat`.

Ou depuis un terminal, à la racine du projet :

```bash
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Le script enchaîne automatiquement :

1. `setup-node.ps1` → télécharge Node.js **22.18.0 x64** dans `provider/node/`
2. Ajoute `provider/node` au `PATH` de la session PowerShell
3. `npm install` → installe `electron`, `adm-zip`, `obs-websocket-js`
4. `npm start` → lance la fenêtre Electron

Le premier lancement prend quelques minutes (téléchargement de Node + Electron ~250 Mo).

> ⚠️ Lancez **toujours** l'application via `start.bat` ou `start.ps1`. Un `npm start`
> direct échoue avec `'node' n'est pas reconnu` si Node n'est pas installé sur le
> système : c'est le script de démarrage qui met `provider/node` dans le `PATH`.

### Mode développement

```bash
powershell -ExecutionPolicy Bypass -File .\start.ps1 -Dev
```

Ouvre les DevTools au démarrage. `Ctrl+Shift+I` fonctionne aussi à tout moment.

### Lancement manuel (si Node est déjà en place)

```bash
.\provider\node\npm.cmd install
```

```bash
.\provider\node\npm.cmd start
```

---

## 3. Onglet Setup — installer les dépendances

Au démarrage, l'application affiche 4 indicateurs de statut :

| Composant | Chemin attendu |
|---|---|
| Node.js | `provider/node/node.exe` (sinon le `node` du système) |
| OBS Studio | `provider/obs/bin/64bit/obs64.exe` |
| FFmpeg | `provider/ffmpeg/bin/ffmpeg.exe` |
| FFprobe | `provider/ffmpeg/bin/ffprobe.exe` |

Tant que les 4 ne sont pas verts, l'onglet **LED Control** reste désactivé.

Cliquez sur **Download** pour OBS puis pour FFmpeg. Le téléchargement puis
l'extraction affichent chacun leur pourcentage, et l'installation est vérifiée à la
fin (l'exécutable attendu doit être présent). FFprobe est installé en même temps que
FFmpeg : les deux sont dans la même archive.

Versions installées : **OBS Studio 30.2.3** (épinglée) et la dernière build
« essentials » de FFmpeg.

Cliquez sur **Refresh All** pour rafraîchir les voyants. Une fois les 4 au vert,
l'onglet LED Control se débloque.

### Installation manuelle (secours)

Si le réseau bloque les téléchargements (proxy, pare-feu d'entreprise) :

**OBS Studio** — récupérez `OBS-Studio-30.2.3-Windows.zip` depuis
<https://github.com/obsproject/obs-studio/releases/tag/30.2.3> et décompressez le
contenu dans `provider/obs/` (vous devez obtenir `provider/obs/bin/64bit/obs64.exe`).

**FFmpeg** — récupérez `ffmpeg-release-essentials.zip` depuis
<https://www.gyan.dev/ffmpeg/builds/>, puis copiez le **contenu** du dossier
`ffmpeg-XX-essentials_build/` (donc `bin/`, `doc/`, `presets/`) dans `provider/ffmpeg/`.
Vous devez obtenir `provider/ffmpeg/bin/ffmpeg.exe` et `provider/ffmpeg/bin/ffprobe.exe`.

---

## 4. Préparer les médias

Créez les deux dossiers (ils sont ignorés par git, donc absents d'un clone frais) :

```bash
mkdir -p data/PARTNERS_VIDEOS data/PARTNERS_LOGO
```

- `data/PARTNERS_VIDEOS/` — vidéos des partenaires diffusées en boucle
  - Formats acceptés : `.mp4` directement ; `.mov`, `.webm`, `.mkv`, `.avi`, `.wmv`
    sont convertis en MP4 au lancement d'OBS
  - `.png`, `.jpg`, `.jpeg` sont convertis en vidéos MP4 de 5 s (image centrée,
    largeur 1720 px, sur fond noir 1920×1080)
  - Les fichiers sources sont déplacés dans `ORIGINAL/` après conversion, jamais supprimés
  - Durée recommandée : 15 s (l'automatisation change de vidéo toutes les 15 s)
- `data/PARTNERS_LOGO/` — images du diaporama de logos

### Panneau Media Library

Le panneau **Media Library** de l'onglet LED Control gère ce dossier :

- **Browse…** ouvre le sélecteur de dossier Windows ; 📂 ouvre le dossier dans
  l'Explorateur. Le chemin peut être absolu ou relatif à la racine du projet.
- Les statistiques affichent le nombre de vidéos de la boucle, la **durée totale**,
  la **durée moyenne** d'un clip et la taille sur disque. Les durées sont lues avec
  `ffprobe`. Les fichiers non gérés sont comptés à part et ignorés.
- **La conversion est automatique et obligatoire.** Au chargement du dossier, à
  chaque changement de dossier et à chaque lancement d'OBS, tout ce qui n'est pas
  du MP4 est converti, avec une barre de progression dans le panneau.
- **Les fichiers d'origine ne sont pas supprimés** : ils sont déplacés dans un
  sous-dossier `ORIGINAL/` du dossier média. En cas d'homonyme déjà archivé, le
  nouveau est suffixé (`clip (2).mov`). Ce sous-dossier est ignoré par les
  statistiques, par la synchronisation et par le watchdog.
- **Convert & Sync LOOP_IND** convertit puis met la scène `LOOP_IND` en miroir du
  dossier : une source est créée pour chaque nouveau MP4, les sources dont le
  fichier a disparu sont retirées.
- **Watch the folder** active un watchdog : toute modification du dossier
  (ajout, suppression) relance conversion + synchronisation toute seule, après
  2 secondes de temporisation pour absorber les copies en rafale.

Les sources créées reprennent la mise en forme de la collection livrée :
`ffmpeg_source`, cadrage *scale inner* 1920×1080, masquée jusqu'à ce que
l'automatisation l'affiche. Elles sont aussi réglées sur **close when inactive**,
sans quoi OBS garde un verrou sur chaque fichier et Windows refuse de supprimer
une vidéo tant qu'OBS tourne.

---

## 5. Onglet LED Control — utilisation

1. **Launch OBS** — une seule action, aucune configuration manuelle. L'app :
   - convertit les médias de `PARTNERS_VIDEOS` si besoin ;
   - réécrit les chemins absolus selon l'emplacement du projet ;
   - installe la collection de scènes sous le nom **OBS-MAIN-LED** et la
     sélectionne dans `global.ini` ;
   - active le serveur WebSocket d'OBS avec l'adresse et le mot de passe saisis
     dans le bandeau du haut ;
   - démarre OBS en mode portable sur cette collection.

   La progression s'affiche dans une fenêtre modale et dans le journal d'activité.
2. **Connect** — la connexion est tentée automatiquement 8 secondes après le
   lancement ; le bouton sert à réessayer. L'app ouvre alors un projecteur plein
   écran sur le **2ᵉ moniteur** (ignoré s'il n'y en a qu'un).
3. **Initialize** — recense les sources des scènes `SCORES` et `LOOP_IND`.
4. **Start Automation** — démarre la boucle.

> Si vous changez le mot de passe dans le bandeau, relancez **Launch OBS** pour
> qu'OBS soit reconfiguré avec la nouvelle valeur.

### Réglages d'automatisation

| Réglage | Défaut | Effet |
|---|---|---|
| Include scores in automation | activé | Décoché, seules les vidéos partenaires tournent |
| Video duration (ms) | 15000 | Durée d'affichage de chaque vidéo |
| Score interval (ms) | 20000 | Durée d'affichage de chaque score |
| Transition time (ms) | 300 | Délai avant le passage aux scores |
| Videos between scores | 5 | Nombre de vidéos entre deux blocs de scores |

Le dossier des médias se règle dans le panneau **Media Library**, pas ici.

Les réglages sont lus **au moment où vous cliquez sur Start Automation**. Pour les
changer, arrêtez puis redémarrez l'automatisation.

**Stop Automation** interrompt aussi une séquence de scores en cours.

### Scènes attendues dans OBS

`LOGO-ITJR`, `COURT-TENNIS`, `SCORES`, `LOOP_IND` — fournies par
`data/obs-scene-collection.json`, installée par **Launch OBS** sous le nom de
collection **OBS-MAIN-LED**.

Le nom de la collection doit rester identique entre le champ `name` du JSON,
le nom de fichier dans `provider/obs/config/obs-studio/basic/scenes/` et
`[Basic] SceneCollection` dans `global.ini` : OBS résout `--collection` sur le
**nom**, pas sur le nom de fichier. C'est [`js/obsConfig.js`](js/obsConfig.js) qui
maintient les trois en cohérence.

---

## 6. Limites connues

| Symptôme | Cause | Contournement |
|---|---|---|
| `data/obs-scene-collection.json` apparaît modifié dans git après chaque lancement | `updateSceneCollectionPaths()` réécrit le fichier source au lieu de la copie dans `provider/` | Normal si le projet a changé d'emplacement ; sinon `git checkout data/obs-scene-collection.json` |
| OBS reste actif quelques secondes à la fermeture de l'application | OBS enregistre sa configuration puis se bloque dans `obs_module_unload` d'obs-websocket. L'app attend 8 s après l'enregistrement, puis termine le processus | Aucun ; la collection de scènes est bien sauvegardée avant |
| Une vidéo supprimée réapparaît dans `LOOP_IND` au lancement suivant | La collection livrée `data/obs-scene-collection.json` est réinstallée à chaque lancement d'OBS avec ses 25 sources d'origine | Lancer **Convert & Sync LOOP_IND** après le démarrage, ou laisser le watchdog actif |

---

## 7. Version, build et publication

La version affichée dans l'en-tête de l'application vient de `package.json`.
Survolez le badge pour voir aussi les versions d'Electron, Node et Chromium —
utile dans un rapport de bug.

### Construire l'artefact localement

```bash
.\provider\node\npm.cmd run dist
```

Produit `dist/OBS Main LED-<version>-win-x64.zip` (~105 Mo). Décompressez-le où
vous voulez et lancez `OBS Main LED.exe` : ni Node ni `start.bat` ne sont requis,
Electron est embarqué.

Deux choix de packaging à ne pas défaire :

- **`asar: false`** — l'application écrit dans `provider/` et `data/` à côté de
  `__dirname`. Dans une archive asar, ces chemins sont en lecture seule et le
  téléchargement d'OBS comme le lancement échoueraient.
- **cible `zip`, pas `portable`** — une cible `portable` se décompresse dans un
  dossier temporaire neuf à chaque exécution, ce qui jetterait `provider/` et donc
  l'installation d'OBS à chaque démarrage.

Les médias (`PARTNERS`, `PARTNERS_VIDEOS`, `PARTNERS_LOGO`) et `provider/` ne sont
pas embarqués : ce sont respectivement votre contenu et des dépendances
téléchargées à l'exécution. Après la première décompression, passez par l'onglet
Setup pour installer OBS et FFmpeg.

### Publier une version

Le workflow [`.github/workflows/build.yml`](.github/workflows/build.yml) construit
l'artefact à chaque push sur `master`, sur chaque pull request et à la demande. Sur
un tag `v*`, il publie en plus une release GitHub avec le zip.

```bash
git tag -a v1.2.0 -m "Description de la version"
```

```bash
git push origin v1.2.0
```

> ⚠️ Mettez `package.json` à jour **avant** de poser le tag. Le workflow refuse la
> release si le tag et la version du manifeste diffèrent, pour éviter de publier un
> artefact dont le nom de fichier et la version affichée ne correspondent pas.

---

## 8. Dépannage courant

**« L'exécution de scripts est désactivée sur ce système »**
Utilisez `start.bat`, qui passe déjà `-ExecutionPolicy Bypass`.

**`'node' n'est pas reconnu en tant que commande interne ou externe`**
Vous avez lancé `npm start` directement. Passez par `start.bat` / `start.ps1`.

**`Connection failed: Connection refused`**
Le serveur WebSocket est configuré automatiquement par **Launch OBS**. Si la
connexion échoue quand même : OBS n'a pas fini de démarrer (réessayez avec
**Connect**), OBS a été lancé à la main sans passer par l'app, ou le port 4455 est
bloqué par le pare-feu. En dernier recours, dans OBS :
`Outils → Paramètres du serveur WebSocket` → activer, port `4455`, mot de passe `123456`.

**OBS s'ouvre sur une scène vide / la mauvaise collection**
Vérifiez dans OBS que `Scene Collection` est bien sur **OBS-MAIN-LED**. La
collection par défaut « Sans nom » créée par OBS à sa première exécution reste
listée, elle est sans effet.

**Le téléchargement échoue avec `HTTP 403` ou `Request failed`**
Réseau ou proxy bloquant. Utilisez l'installation manuelle (section 3).

**La conversion FFmpeg échoue**
Vérifiez `provider/ffmpeg/bin/ffmpeg.exe`, les droits d'écriture sur
`data/PARTNERS_VIDEOS/` et l'espace disque disponible.

**Pas de projection plein écran**
Un seul moniteur détecté — l'app ignore silencieusement l'étape. Vérifiez le journal.

**Repartir de zéro**

```bash
powershell -Command "Remove-Item -Recurse -Force provider, node_modules, temp -ErrorAction SilentlyContinue"
```

Puis relancez `start.bat`.
