# BlendEngine — Baholash

[README](../README.md) · [Loyiha xaritasi](PROJECT_GUIDE.md)

## Dalillar holati

Quyidagi 3D runtime o'lchovlari aniq muhit bilan qayd etilgan; boshqa yo'nalishlar hali o'lchanmagan.

## 3D Runtime o'lchovlari

| Maydon | Qiymat |
|---|---|
| Muhit | Linux konteyner, Blender `bpy` 5.2.3 moduli (headless), Chromium (Playwright) SwiftShader dasturiy GPU |
| Ssenariy | `tests/runtime_web/export_templates.py` bilan eksport qilingan 3D Starter World va Cyberpunk Zombie Shooter |
| Eksport vaqti | Starter: ~0.06 s (52 mesh, 6 809 uchburchak); Shooter: ~0.2 s (83 mesh, 57 360 uchburchak) |
| Gameplay testi | `tests/runtime_web/gameplay_test.js` — 13/13 tekshiruv o'tdi |
| Film testi | `tests/runtime_web/film_test.js` — 7/7 o'tdi (kamera almashinuvi, The End, 3 kadr × 6 sub-sample PNG/ZIP) |
| Blender Film Render | Cycles CPU, 4 sample, 320×180, 6 kadr → H.264 MP4 (~8 s, `ffprobe` bilan tekshirildi); Eevee bu konteynerda GPU/EGL yo'qligi sababli sinalmadi |
| Eksport testi | `tests/python/blendengine_scene_export_test.py` — 8/8 o'tdi |
| Editor Test Run qadami (120 kadr o'rtachasi) | Starter: 3.2 → 1.3 ms; Shooter: 4.4 → 1.3 ms (`bpy` headless, viewport chizishsiz) |
| Cheklov | FPS qiymatlari dasturiy renderda olingan va haqiqiy GPU'dagi tezlikni ko'rsatmaydi; haqiqiy qurilmalarda o'lchanmagan |

## Nima o‘lchanadi?

| Yo‘nalish | Ushbu hujjatdagi holat |
|---|---|
| Build vaqti va natijasi | O‘lchash va hisobotga yozish kerak |
| Bir xil sahnada frame time | O‘lchash va hisobotga yozish kerak |
| Xotira ishlatilishi | O‘lchash va hisobotga yozish kerak |

## Qayta chiqarish protokoli

1. Commit SHA va branchni qayd eting.
2. OS, runtime, dependency versiyalari va apparatni yozing.
3. Ishlatilgan test ma’lumoti, konfiguratsiya va buyruqni saqlang.
4. Warm-up, takrorlash soni va o‘lchov chegarasini belgilang.
5. Taqqoslashda bir xil sharoitdan foydalaning; muhit farqlarini yozing.
6. Median, tarqoqlik, xatolar va o‘tkazib yuborilgan holatlarni ko‘rsating.

## Hisobot shakli

| Maydon | To‘ldiriladigan ma’lumot |
|---|---|
| Commit / konfiguratsiya | Aniq identifikator |
| Muhit | OS, runtime, qurilma, resurs limitlari |
| Ma’lumot / ssenariy | Manba, versiya, o‘lcham |
| Buyruq | Qayta bajariladigan aniq buyruq |
| Natija | Qiymat, birlik, takrorlar soni |
| Cheklov | O‘lchanmagan yoki qo‘llanmaydigan holatlar |

Test muvaffaqiyati, tezlik va foydalanuvchi sifati alohida xulosalardir. Lokal natijani production kafolati sifatida ko‘rsatmang. Maxfiy ma’lumotlarni hisobotga kiritmang.
