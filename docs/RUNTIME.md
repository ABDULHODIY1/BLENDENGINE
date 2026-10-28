# BlendEngine — 3D Runtime (WebGL2)

[README](../README.md) · [Loyiha xaritasi](PROJECT_GUIDE.md) · [Baholash](EVALUATION.md) · [Changelog](../CHANGELOG.md)

![3D Starter World 3D runtime'da](images/runtime_3d_starter.png)

*3D Starter World shabloni eksport qilingandan keyin brauzerda (ultra sifat, SwiftShader dasturiy renderida olingan).*

## Bu nima?

BlendEngine endi har bir eksportga **mustaqil 3D o'yin playerini** (`web_player/`) qo'shadi. U Blender'siz ishlaydi:
Chrome, Edge, Firefox, Safari, Android WebView va iOS WKWebView'da. Runtime bitta JavaScript fayl
(`blendengine_runtime.js`, ~130 KB), hech qanday tashqi kutubxona yoki server talab qilinmaydi —
`index.html` ni to'g'ridan-to'g'ri diskdan ochish kifoya.

| Qism | Fayl |
|---|---|
| Sahna eksporti (mesh, material, tekstura, yorug'lik, kamera, gameplay) | [`scripts/addons_core/blendengine/scene_export.py`](../scripts/addons_core/blendengine/scene_export.py) |
| Runtime (render, fizika, AI, gameplay, kiritish) | [`scripts/addons_core/blendengine/runtime_web/blendengine_runtime.js`](../scripts/addons_core/blendengine/runtime_web/blendengine_runtime.js) |
| Player sahifasi (HUD, menyu, touch boshqaruv) | [`scripts/addons_core/blendengine/runtime_web/index.html`](../scripts/addons_core/blendengine/runtime_web/index.html) |
| Paketlash (Web, Android, iOS, Desktop) | [`scripts/addons_core/blendengine/export_system.py`](../scripts/addons_core/blendengine/export_system.py) |

## Imkoniyatlar

**Render (realistik, lekin yengil)**
- Fizikaga asoslangan shading (GGX / Smith / Schlick) — Principled BSDF'dan base color, metallic, roughness, emission, alpha, normal map va teksturalar.
- Quyosh uchun yumshoq PCF soyalar, kamera atrofida texel-snapping bilan barqaror soya xaritasi.
- 16 tagacha point/spot yorug'lik (kameraga eng ta'sirlisi tanlanadi).
- Prosedural osmon (quyosh balandligiga qarab kun/shom ranglari, quyosh diski) yoki World rangi.
- Osmondan ambient va split-sum yaqinlashuvidagi aks ettirishlar, balandlik bilan susayuvchi tuman.
- HDR pipeline: bloom, SSAO, ACES tone mapping, vinyetka, FXAA.
- Frustum culling, material bo'yicha saralash, bir xil mesh'lar uchun bitta GPU bufer, dinamik resolution (FPS tushsa avtomatik pasayadi).

**Fizika**
- Statik dunyo uchburchaklari fazoviy hash'da (katta shaharlar uchun ham tez).
- Kapsula-simon personaj kontrolleri: qiyaliklar, zinapoyalar, yerga yopishish, coyote-time sakrash, yiqilish zarari.
- Ray cast (3D DDA), eshiklar uchun AABB colliderlar, ikki tomonlama geometriya.
- Oddiy rigid body'lar (`RIGIDBODY` komponenti): sfera yaqinlashuvi, gravitatsiya, sakrash, ishqalanish, personajlar itarishi, uxlash rejimi.

**Gameplay**
- Kontrollerlar: First Person, Third Person (kamera to'qnashuvi bilan), Top Down, Side Scroller, Flying, Vehicle.
- NPC AI shablonlari: Idle, Patrol, Follow, Flee, Attack, Guard Area, Talk/Quest/Shop, Enemy Boss, Companion — ko'rish chizig'i, devorni aylanib o'tish, bir-biridan qochish.
- Qurollar (hitscan, o'q-dori, qayta o'qlash, muzzle flash), yaqin jang, sog'liq, zarar effekti.
- No-code behavior tizimi to'liq: hodisalar, shartlar, amallar (`ON_START`, `ON_UPDATE`, `ON_KEY_PRESS`, `ON_TIMER`, `ON_ENTER_TRIGGER`, `ON_COLLISION`, `ON_CLICK_OBJECT`, `ON_HEALTH_CHANGED` ...).
- O'rnatilgan qoidalar (o'chirsa bo'ladi): `Coin` — ochko, `Health`/`Med` — davolash, `Damage` — zarar zonasi, `Checkpoint` — saqlash, `Ammo` — o'q, `Goal`/`Exit`/`Portal` — g'alaba (barcha tangalar yig'ilgach), `Door`/`Gate` — `E` bilan ochiladi.

**Platforma**
- Klaviatura + sichqoncha (pointer lock), gamepad (standart mapping), telefonlar uchun virtual joystik va tugmalar.
- Protsedural WebAudio tovush effektlari (asset fayl kerak emas).
- Menyu, pauza, g'alaba / mag'lubiyat ekranlari, F3 — ishlash statistikasi.

## Ishlatish

1. BlendEngine'da o'yin yarating (masalan **Magic Create** yoki **3D Starter World**).
2. **Ship** sahifasida: platformani tanlang, **3D Runtime Player** yoqilgan bo'lsin, kerak bo'lsa Sky / Exposure / Bloom / Fog / Ambient Occlusion ni sozlang.
3. **Prepare Build Package** — paket `build_folder/<Package Name>/` ga yoziladi.
4. `web_player/index.html` ni brauzerda oching.

Sifatni URL orqali almashtirish mumkin: `index.html?quality=low|medium|high|ultra`.

Android paketi `android_project/` ichida runtime'ni WebView'ga o'raydi; iOS paketi `ios_project/` da SwiftUI/WKWebView manbalarini beradi. APK/IPA yig'ish uchun Android SDK yoki Xcode va imzolash kerak.

## Skript yozish (ixtiyoriy)

`web_player/game_scripts.js` qayta eksportda ustiga yozilmaydi:

```js
BlendEngine.on('start', (game) => game.toast('Xush kelibsiz!'));
BlendEngine.on('kill', (game, enemy) => console.log('Yengildi:', enemy.name));
BlendEngine.on('update', (game, dt) => { /* har kadr */ });

// Behavior'dagi "Custom Script" amali, Text = "openVault":
BlendEngine.scripts.openVault = ({ game, owner, target }) => { target.alive = false; };
```

Boshqa hodisalar: `trigger`, `victory`, `gameover`, `quest`, `animation`, `cutscene`.

## Sinov

```bash
# Eksport testi (Blender yoki bpy moduli bilan)
blender --background --factory-startup --python tests/python/blendengine_scene_export_test.py

# Shablonlarni headless eksport qilish
blender --background --factory-startup --python tests/runtime_web/export_templates.py -- /tmp/be basic shooter 2d

# Brauzerda gameplay testi (Node.js + Playwright)
node tests/runtime_web/gameplay_test.js /tmp/be/basic/web_player /tmp/be/shooter/web_player
```

## Cheklovlar

Halollik uchun: quyidagilar hozircha **yo'q**.

- Skelet (armature) animatsiyasi va shape key'lar eksport qilinmaydi; personajlar protsedural yurish/egilish harakati bilan siljiydi.
- Real-time global illumination va lightmap bake yo'q; ambient osmondan keladi, AO esa ekran fazosida.
- Faqat quyosh soya tashlaydi; point/spot yorug'liklar soyasiz.
- Rigid body'lar sfera sifatida hisoblanadi (aylanish va constraint'lar yo'q).
- Multiplayer sozlamalari eksport qilinadi, lekin tarmoq kodi runtime'da yo'q.
- Bitta sahna eksport qilinadi; `LOAD_SCENE` amali joriy darajani qayta boshlaydi.
