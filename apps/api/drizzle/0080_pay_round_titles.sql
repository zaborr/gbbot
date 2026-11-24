UPDATE "products" SET "title" = replace("title", 'Fase extra · ', 'Fase «Pagar» · '), "title_en" = replace("title_en", 'Extra round · ', '«Pay» round · ') WHERE "kind" = 'extra';
