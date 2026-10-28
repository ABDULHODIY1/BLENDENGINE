# Changelog

## Unreleased

### Engine

- **3D Runtime (WebGL2):** `scripts/addons_core/blendengine/runtime_web/` — Blender'siz ishlaydigan mustaqil o'yin playeri: PBR (GGX), quyosh soyalari (PCF), point/spot yorug'liklar, prosedural osmon, tuman, HDR bloom, SSAO, ACES, FXAA, dinamik resolution.
- **Fizika:** statik uchburchak dunyosi (spatial hash), personaj kontrolleri (qiyalik, zinapoya, yerga yopishish), ray cast, eshiklar, oddiy rigid body'lar.
- **Gameplay:** 6 xil kontroller, NPC AI shablonlari, qurol/yaqin jang, behavior tizimi (hodisa/shart/amal), pickup va g'alaba qoidalari, gamepad, touch boshqaruv, WebAudio effektlar, `game_scripts.js` skript API.
- **Eksport:** `scene_export.py` — mesh (welded split normals, UV, material guruhlari), Principled BSDF materiallar, teksturalar (sifatga qarab kichraytiriladi), yorug'lik, kamera, World. Web, Android, iOS va Desktop paketlari endi 3D playerni o'z ichiga oladi.
- **Editor Test Run:** keshlar, Ground BVH va sweep-and-prune bilan 2–3 barobar tezroq qadam; o'yinchi relyef balandligini kuzatadi.
- **Film Studio:** Blender timeline animatsiyasi va kamera marker'lari bake qilinadi; runtime sequencer (film rejimi va o'yin ichidagi cutscene'lar), kino post-effektlar (DOF, motion blur, letterbox, grain, chromatic aberration, gradatsiya), sub-kadr yig'uvchi offline PNG/ZIP render, WebM yozuv; Blender'da *Render Film* (Cycles/Eevee → MP4), *Cinematic Camera*, *Cut To Camera*, *Demo Film Sequence*.
- **Zamonaviy UI:** yon panel 18 tabdan 13 taga qisqartirildi (hammasi 900 px ekranga sig'adi); katta asosiy tugmalar (Play, Build Game, Render Film), statistika kartalari, Project Health ro'yxati, ikonkali 2 ustunli tugmalar, WHEN / IF / DO qoidalar muharriri, platformani bitta bosish bilan tanlash, kesilmaydigan qisqa yorliqlar, yumaloq vidjetlar.
- **Animatsiyali proplar:** o'yin davomida aylanadi; collider'li animatsiyali obyektlar kinematik platforma bo'lib o'yinchini olib yuradi.
- **Testlar:** `tests/python/blendengine_scene_export_test.py`, `tests/runtime_web/` (headless eksport, Playwright gameplay va film testlari).

### Documentation

- Loyiha banneri va monogramma, arxitektura xaritasi, boshlang‘ich misol va navigatsiya qo‘shildi.
- Roadmap, baholash protokoli va reliz tartibi hujjatlashtirildi.
- Hujjatlar tekshiruvi uchun alohida CI workflow qo‘shildi.

Bu yozuv dastur relizi emas. Ilova manba kodi ushbu hujjatlashtirish ishida o‘zgartirilmadi. Oldingi o‘zgarishlar tarixi commitlarda saqlanadi; bu yerda qayta to‘qib yozilmagan.
