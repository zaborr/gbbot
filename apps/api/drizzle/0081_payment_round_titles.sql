UPDATE "products" SET "title" = replace("title", 'Fase «Pagar» · ', 'Fase de pago · '), "title_en" = replace("title_en", '«Pay» round · ', 'Payment round · ') WHERE "kind" = 'extra';
