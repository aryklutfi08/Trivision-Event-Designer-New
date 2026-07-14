Studio C — AI render reference photo
====================================

The "3D Render" button in the Studio C designer generates a photorealistic
AI image of the real room furnished with the current layout. It uses one
fixed reference photo as the base:

  empty-room.png   ← REQUIRED. The wide empty-room photo of Studio C
                     (black ceiling with pipes + track lights, white
                     textured back wall, wood panel on the right,
                     dark carpet). Save it at exactly this path:
                     public/studio-c/empty-room.png

Until this file exists, the render button shows a clear error and nothing
is charged. The camera angle of every AI render follows this photo, so
pick the angle you want clients to see.

Also required (server side): OPENAI_API_KEY in .env (locally) or in the
Vercel project environment variables (production). See .env.example.

Furniture reference photos — furniture/<furnId>.png|jpg|jpeg
------------------------------------------------------------
Optional but strongly recommended: a real photo of each furniture setup.
When a layout includes that furniture type, its photo is attached to the
AI request and the prompt says "replicate this exact styling".

Furniture ids (from the designer palette):
  round-60        Small Round Table        round-72   Big Round Table
  cocktail        Cocktail Table           rect-6     Long Table (2×6)
  rect-8          Long Table (3×8)         banquet-chair  Black Chair
  theatre-chair   Theatre Chair            lounge-sofa    Lounge Sofa
  lounge-chair    Lounge Chair             podium     Podium / Lectern
  stage-deck      Stage Deck 4×8           drape      Pipe & Drape

Currently present:
  furniture/round-60.jpg        black linen + 6 black spandex chairs,
                                gold cordless lamp, black/gold round rug
  furniture/banquet-chair.jpg   black spandex-covered folding chair
