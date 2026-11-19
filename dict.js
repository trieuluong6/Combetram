// dict.js
// Kiến trúc tối ưu:
// - 24 cờ dùng chung 20 gói ngôn ngữ (en/sg, de/at/ch, nl/be dùng chung gói gốc).
// - Nguồn sự thật duy nhất (LANG_BUTTONS) cho cả lưới cờ trên giao diện lẫn dữ liệu bill.
// - Tự động sinh tên bia (ID 35..39) theo quy tắc từng ngôn ngữ & tự kiểm tra thiếu/sai ID qua validateMenuDict(menu).

const BEER_BRANDS = {
  35: "Larue",
  36: "Huda",
  37: "Saigon",
  38: "Tiger",
  39: "Heineken"
};

function buildBeers(format) {
  const out = {};
  for (const [id, brand] of Object.entries(BEER_BRANDS)) {
    out[id] = format.replace("{brand}", brand);
  }
  return out;
}

const LANG_PACKS = {
  vi: {
    total: "TỔNG",
    thanks: "Cảm ơn quý khách & hẹn gặp lại!",
    items: {} // Tiếng Việt lấy trực tiếp tên gốc từ menu.js
  },

  // Dùng chung cho: 🇺🇸 EN, 🇸🇬 SG
  en: {
    total: "TOTAL",
    thanks: "Thank you & see you again!",
    beerFormat: "{brand} Beer",
    items: {
      1: "Grilled pork chops and egg rice",
      2: "Shredded chicken rice",
      3: "Fried chicken thigh with fish sauce rice",
      4: "Seafood fried rice",
      5: "Crispy fried chicken thigh rice",
      6: "Stir-fried beef with vegetables and rice",
      7: "Stir-fried beef noodles",
      8: "Seafood fried noodles",
      9: "Stir-fried beef glass noodles",
      10: "Stir-fried seafood glass noodles",
      11: "Chicken glass noodle soup",
      12: "Beef glass noodle soup",
      13: "Seafood glass noodle soup",
      14: "Clam rice porridge",
      15: "Beef rice porridge",
      16: "Steamed clams",
      17: "Stir-fried clams",
      18: "Steamed shrimp",
      19: "Fried shrimp with fish sauce",
      20: "Steamed squid",
      21: "Fried squid with fish sauce",
      22: "Extra egg",
      23: "Extra bitter melon soup",
      24: "Fried spring roll (1 pc)",
      25: "Extra grilled pork chop",
      26: "Extra fried chicken thigh with fish sauce",
      27: "Extra shredded chicken",
      28: "Extra crispy fried chicken thigh",
      29: "Assorted soft drinks",
      30: "Red Bull",
      31: "Bottled water",
      32: "Still mineral water",
      33: "Fresh coconut water",
      34: "Fresh orange juice",
      40: "Extra rice",
      41: "Extra stir-fried beef with vegetables"
    }
  },

  fr: {
    total: "TOTAL",
    thanks: "Merci et à très bientôt !",
    beerFormat: "Bière {brand}",
    items: {
      1: "Riz aux côtes de porc grillées et œuf",
      2: "Riz au poulet effiloché",
      3: "Riz aux cuisses de poulet au nuoc-mâm",
      4: "Riz sauté aux fruits de mer",
      5: "Riz à la cuisse de poulet croustillante",
      6: "Bœuf sauté aux légumes avec riz",
      7: "Nouilles sautées au bœuf",
      8: "Nouilles sautées aux fruits de mer",
      9: "Vermicelles sautés au bœuf",
      10: "Vermicelles sautés aux fruits de mer",
      11: "Soupe de vermicelles au poulet",
      12: "Soupe de vermicelles au bœuf",
      13: "Soupe de vermicelles aux fruits de mer",
      14: "Bouillie de palourdes",
      15: "Bouillie de bœuf",
      16: "Palourdes à la vapeur",
      17: "Palourdes sautées",
      18: "Crevettes à la vapeur",
      19: "Crevettes frites au nuoc-mâm",
      20: "Calmar à la vapeur",
      21: "Calmar frit au nuoc-mâm",
      22: "Œuf supplémentaire",
      23: "Soupe de margose supplémentaire",
      24: "Nem frit (1 pc)",
      25: "Côte de porc grillée supplémentaire",
      26: "Cuisse de poulet au nuoc-mâm supplémentaire",
      27: "Poulet effiloché supplémentaire",
      28: "Cuisse de poulet croustillante supplémentaire",
      29: "Sodas de toutes sortes",
      30: "Red Bull",
      31: "Eau de source",
      32: "Eau minérale plate",
      33: "Eau de coco fraîche",
      34: "Jus d'orange frais",
      40: "Riz supplémentaire",
      41: "Bœuf sauté aux légumes supplémentaire"
    }
  },

  kr: {
    total: "합계",
    thanks: "감사합니다. 또 오세요!",
    items: {
      1: "돼지갈비 구이와 달걀프라이 덮밥",
      2: "찢은 닭고기 덮밥",
      3: "피시 소스 닭다리 튀김 덮밥",
      4: "해산물 볶음밥",
      5: "바삭한 닭다리 튀김 덮밥",
      6: "소고기 야채 볶음 덮밥",
      7: "소고기 볶음면",
      8: "해산물 볶음면",
      9: "소고기 볶음당면",
      10: "해산물 볶음당면",
      11: "닭고기 당면국수",
      12: "소고기 당면국수",
      13: "해산물 당면국수",
      14: "조개죽",
      15: "소고기죽",
      16: "조개 찜",
      17: "조개 볶음",
      18: "새우 찜",
      19: "피시 소스 새우 튀김",
      20: "오징어 찜",
      21: "피시 소스 오징어 튀김",
      22: "달걀 추가",
      23: "여주 국 추가",
      24: "튀김 스프링롤 (1개)",
      25: "돼지갈비 구이 추가",
      26: "피시 소스 닭다리 추가",
      27: "찢은 닭고기 추가",
      28: "바삭한 닭다리 추가",
      29: "탄산음료",
      30: "레드불",
      31: "생수",
      32: "무탄산 미네랄 워터",
      33: "코코넛 워터",
      34: "생오렌지 주스",
      35: "라루 맥주",
      36: "후다 맥주",
      37: "사이공 맥주",
      38: "타이거 맥주",
      39: "하이네켄 맥주",
      40: "공기밥 추가",
      41: "소고기 야채 볶음 추가"
    }
  },

  jp: {
    total: "合計",
    thanks: "ありがとうございました。またお越しください！",
    items: {
      1: "豚リブ焼きと目玉焼きご飯",
      2: "ほぐし鶏ご飯",
      3: "鶏もも肉のヌクマム揚げご飯",
      4: "海鮮チャーハン",
      5: "カリカリ鶏もも肉揚げご飯",
      6: "牛肉と野菜炒めご飯",
      7: "牛肉炒め麺",
      8: "海鮮炒め麺",
      9: "牛肉炒め春雨",
      10: "海鮮炒め春雨",
      11: "鶏肉汁春雨",
      12: "牛肉汁春雨",
      13: "海鮮汁春雨",
      14: "ハマグリ粥",
      15: "牛肉粥",
      16: "ハマグリ蒸し",
      17: "ハマグリ炒め",
      18: "エビ蒸し",
      19: "エビのヌクマム揚げ",
      20: "イカ蒸し",
      21: "イカのヌクマム揚げ",
      22: "追加目玉焼き",
      23: "追加ゴーヤスープ",
      24: "揚げ春巻き (1個)",
      25: "追加豚リブ焼き",
      26: "追加鶏もも肉ヌクマム揚げ",
      27: "追加ほぐし鶏",
      28: "追加カリカリ鶏もも肉揚げ",
      29: "ソフトドリンク各種",
      30: "レッドブル",
      31: "天然水",
      32: "無炭酸ミネラルウォーター",
      33: "新鮮なココナッツジュース",
      34: "生オレンジジュース",
      35: "ラルービール",
      36: "フダビール",
      37: "サイゴンビール",
      38: "タイガービール",
      39: "ハイネケンビール",
      40: "追加ご飯",
      41: "追加牛肉と野菜炒め"
    }
  },

  th: {
    total: "รวม",
    thanks: "ขอบคุณค่ะ แล้วพบกันใหม่นะคะ!",
    beerFormat: "เบียร์ {brand}",
    items: {
      1: "ข้าวหน้าซี่โครงหมูย่างและไข่ดาว",
      2: "ข้าวหน้าไก่ฉีก",
      3: "ข้าวหน้าน่องไก่ทอดซอสน้ำปลา",
      4: "ข้าวผัดอาหารทะเล",
      5: "ข้าวหน้าน่องไก่ทอดกรอบ",
      6: "ข้าวหน้าเนื้อผัดผัก",
      7: "บะหมี่ผัดเนื้อ",
      8: "บะหมี่ผัดอาหารทะเล",
      9: "วุ้นเส้นผัดเนื้อ",
      10: "วุ้นเส้นผัดอาหารทะเล",
      11: "วุ้นเส้นน้ำซุปไก่",
      12: "วุ้นเส้นน้ำซุปเนื้อ",
      13: "วุ้นเส้นน้ำซุปอาหารทะเล",
      14: "โจ๊กหอยลาย",
      15: "โจ๊กเนื้อ",
      16: "หอยลายนึ่ง",
      17: "หอยลายผัด",
      18: "กุ้งนึ่ง",
      19: "กุ้งทอดซอสน้ำปลา",
      20: "ปลาหมึกนึ่ง",
      21: "ปลาหมึกทอดซอสน้ำปลา",
      22: "เพิ่มไข่ดาว",
      23: "เพิ่มต้มจืดมะระ",
      24: "ปอเปี๊ยะทอด (1 ชิ้น)",
      25: "เพิ่มซี่โครงย่าง",
      26: "เพิ่มน่องไก่ทอดน้ำปลา",
      27: "เพิ่มไก่ฉีก",
      28: "เพิ่มน่องไก่กรอบ",
      29: "น้ำอัดลมต่างๆ",
      30: "กระทิงแดง",
      31: "น้ำเปล่า",
      32: "น้ำแร่ไม่อัดแก๊ส",
      33: "น้ำมะพร้าวสด",
      34: "น้ำส้มคั้นสด",
      40: "เพิ่มข้าว",
      41: "เพิ่มเนื้อผัดผัก"
    }
  },

  it: {
    total: "TOTALE",
    thanks: "Grazie e arrivederci a presto!",
    beerFormat: "Birra {brand}",
    items: {
      1: "Riso con costolette di maiale alla griglia e uovo",
      2: "Riso con pollo sfilacciato",
      3: "Riso con cosce di pollo alla salsa di pesce",
      4: "Riso fritto ai frutti di mare",
      5: "Riso con coscia di pollo croccante",
      6: "Manzo saltato con verdure e riso",
      7: "Spaghetti saltati con manzo",
      8: "Spaghetti saltati ai frutti di mare",
      9: "Vermicelli saltati con manzo",
      10: "Vermicelli saltati ai frutti di mare",
      11: "Zuppa di vermicelli con pollo",
      12: "Zuppa di vermicelli con manzo",
      13: "Zuppa di vermicelli ai frutti di mare",
      14: "Porridge di vongole",
      15: "Porridge di manzo",
      16: "Vongole al vapore",
      17: "Vongole saltate",
      18: "Gamberi al vapore",
      19: "Gamberi fritti alla salsa di pesce",
      20: "Calamari al vapore",
      21: "Calamari fritti alla salsa di pesce",
      22: "Uovo extra",
      23: "Zuppa di melone amaro extra",
      24: "Involtino primavera fritto (1 pz)",
      25: "Costoletta alla griglia extra",
      26: "Coscia di pollo alla salsa di pesce extra",
      27: "Pollo sfilacciato extra",
      28: "Coscia di pollo croccante extra",
      29: "Bevande analcoliche varie",
      30: "Red Bull",
      31: "Acqua naturale",
      32: "Acqua minerale naturale",
      33: "Acqua di cocco fresca",
      34: "Spremuta d'arancia fresca",
      40: "Riso extra",
      41: "Manzo saltato con verdure extra"
    }
  },

  pt: {
    total: "TOTAL",
    thanks: "Obrigado e volte sempre!",
    beerFormat: "Cerveja {brand}",
    items: {
      1: "Arroz com costeletas de porco grelhadas e ovo",
      2: "Arroz com frango desfiado",
      3: "Arroz com coxas de frango com molho de peixe",
      4: "Arroz frito de frutos do mar",
      5: "Arroz com coxa de frango crocante",
      6: "Carne de vaca refogada com legumes e arroz",
      7: "Massa salteada com carne de vaca",
      8: "Massa salteada com frutos do mar",
      9: "Aletria salteada com carne de vaca",
      10: "Aletria salteada com frutos do mar",
      11: "Sopa de aletria com frango",
      12: "Sopa de aletria com carne de vaca",
      13: "Sopa de aletria com frutos do mar",
      14: "Canja de amêijoas",
      15: "Canja de carne de vaca",
      16: "Amêijoas ao vapor",
      17: "Amêijoas salteadas",
      18: "Camarão ao vapor",
      19: "Camarão frito com molho de peixe",
      20: "Lula ao vapor",
      21: "Lula frita com molho de peixe",
      22: "Ovo extra",
      23: "Sopa de melão amargo extra",
      24: "Rolinho primavera frito (1 un.)",
      25: "Costeleta grelhada extra",
      26: "Coxa de frango com molho de peixe extra",
      27: "Frango desfiado extra",
      28: "Coxa de frango crocante extra",
      29: "Refrigerantes variados",
      30: "Red Bull",
      31: "Água mineral natural",
      32: "Água mineral sem gás",
      33: "Água de coco natural",
      34: "Sumo de laranja natural",
      40: "Arroz extra",
      41: "Carne de vaca refogada com legumes extra"
    }
  },

  es: {
    total: "TOTAL",
    thanks: "¡Gracias y vuelva pronto!",
    beerFormat: "Cerveza {brand}",
    items: {
      1: "Arroz con chuletas de cerdo a la parrilla y huevo",
      2: "Arroz con pollo desmenuzado",
      3: "Arroz con muslos de pollo con salsa de pescado",
      4: "Arroz frito con mariscos",
      5: "Arroz con muslo de pollo crujiente",
      6: "Ternera salteada con verduras y arroz",
      7: "Fideos salteados con ternera",
      8: "Fideos salteados con mariscos",
      9: "Fideos de celofán salteados con ternera",
      10: "Fideos de celofán salteados con mariscos",
      11: "Sopa de fideos de celofán con pollo",
      12: "Sopa de fideos de celofán con ternera",
      13: "Sopa de fideos de celofán con mariscos",
      14: "Gachas de arroz con almejas",
      15: "Gachas de arroz con ternera",
      16: "Almejas al vapor",
      17: "Almejas salteadas",
      18: "Camarones al vapor",
      19: "Camarones fritos con salsa de pescado",
      20: "Calamares al vapor",
      21: "Calamares fritos con salsa de pescado",
      22: "Huevo extra",
      23: "Sopa de melón amargo extra",
      24: "Rollito de primavera frito (1 ud.)",
      25: "Chuleta a la parrilla extra",
      26: "Muslo de pollo a la salsa de pescado extra",
      27: "Pollo desmenuzado extra",
      28: "Muslo de pollo crujiente extra",
      29: "Refrescos de todo tipo",
      30: "Red Bull",
      31: "Agua embotellada",
      32: "Agua mineral sin gas",
      33: "Agua de coco fresca",
      34: "Zumo de naranja fresco",
      40: "Arroz extra",
      41: "Ternera salteada con verduras extra"
    }
  },

  // Trung Giản thể: 🇨🇳 CN
  cn: {
    total: "总计",
    thanks: "谢谢光临，欢迎再来！",
    items: {
      1: "烤猪排加煎蛋饭",
      2: "鸡丝饭",
      3: "鱼露炸鸡腿饭",
      4: "海鲜炒饭",
      5: "脆皮炸鸡腿饭",
      6: "牛肉炒时蔬饭",
      7: "牛肉炒面",
      8: "海鲜炒面",
      9: "牛肉炒冬粉",
      10: "海鲜炒冬粉",
      11: "鸡肉冬粉汤",
      12: "牛肉冬粉汤",
      13: "海鲜冬粉汤",
      14: "蛤蜊粥",
      15: "牛肉粥",
      16: "清蒸蛤蜊",
      17: "炒蛤蜊",
      18: "清蒸大虾",
      19: "鱼露炒大虾",
      20: "清蒸鱿鱼",
      21: "鱼露炒鱿鱼",
      22: "加煎蛋",
      23: "加苦瓜汤",
      24: "炸春卷 (1个)",
      25: "加烤猪排",
      26: "加鱼露鸡腿",
      27: "加鸡丝",
      28: "加脆皮鸡腿",
      29: "各类软饮料",
      30: "红牛",
      31: "饮用水",
      32: "无气矿泉水",
      33: "新鲜椰子汁",
      34: "鲜榨橙汁",
      35: "拉鲁啤酒",
      36: "胡达啤酒",
      37: "西贡啤酒",
      38: "老虎啤酒",
      39: "喜力啤酒",
      40: "加饭",
      41: "加牛肉炒时蔬"
    }
  },

  // Dùng chung cho: 🇩🇪 DE, 🇦🇹 AT, 🇨🇭 CH
  de: {
    total: "GESAMT",
    thanks: "Vielen Dank & auf Wiedersehen!",
    beerFormat: "{brand} Bier",
    items: {
      1: "Reis mit gegrillten Schweinerippchen und Ei",
      2: "Reis mit gezupftem Hähnchenfleisch",
      3: "Reis mit Hähnchenschenkel in Fischsauce",
      4: "Gebratener Reis mit Meeresfrüchten",
      5: "Reis mit knusprig frittiertem Hähnchenschenkel",
      6: "Gebratenes Rindfleisch mit Gemüse und Reis",
      7: "Gebratene Nudeln mit Rindfleisch",
      8: "Gebratene Nudeln mit Meeresfrüchten",
      9: "Gebratene Glasnudeln mit Rindfleisch",
      10: "Gebratene Glasnudeln mit Meeresfrüchten",
      11: "Glasnudelsuppe mit Hähnchen",
      12: "Glasnudelsuppe mit Rindfleisch",
      13: "Glasnudelsuppe mit Meeresfrüchten",
      14: "Muschel-Reissuppe",
      15: "Rindfleisch-Reissuppe",
      16: "Gedämpfte Muscheln",
      17: "Gebratene Muscheln",
      18: "Gedämpfte Garnelen",
      19: "Gebratene Garnelen in Fischsauce",
      20: "Gedämpfter Tintenfisch",
      21: "Gebratener Tintenfisch in Fischsauce",
      22: "Extra Ei",
      23: "Extra Bittermelonensuppe",
      24: "Frittierte Frühlingsrolle (1 Stk.)",
      25: "Extra gegrilltes Rippchen",
      26: "Extra Hähnchenschenkel in Fischsauce",
      27: "Extra gezupftes Hähnchen",
      28: "Extra knuspriger Hähnchenschenkel",
      29: "Alkoholfreie Getränke aller Art",
      30: "Red Bull",
      31: "Stilles Wasser",
      32: "Stilles Mineralwasser",
      33: "Frisches Kokoswasser",
      34: "Frischer Orangensaft",
      40: "Extra Reis",
      41: "Extra gebratenes Rindfleisch mit Gemüse"
    }
  },

  ru: {
    total: "ИТОГО",
    thanks: "Спасибо за визит! Ждём вас снова!",
    beerFormat: "Пиво {brand}",
    items: {
      1: "Рис со свиными ребрышками гриль и яйцом",
      2: "Рис с рваной курицей",
      3: "Рис с куриным бедрышком в рыбном соусе",
      4: "Жареный рис с морепродуктами",
      5: "Рис с хрустящим куриным бедрышком",
      6: "Жареная говядина с овощами и рисом",
      7: "Жареная лапша с говядиной",
      8: "Жареная лапша с морепродуктами",
      9: "Жареная стеклянная лапша с говядиной",
      10: "Жареная стеклянная лапша с морепродуктами",
      11: "Суп со стеклянной лапшой и курицей",
      12: "Суп со стеклянной лапшой и говядиной",
      13: "Суп со стеклянной лапшой и морепродуктами",
      14: "Рисовая каша с моллюсками",
      15: "Рисовая каша с говядиной",
      16: "Моллюски на пару",
      17: "Жареные моллюски",
      18: "Креветки на пару",
      19: "Жареные креветки в рыбном соусе",
      20: "Кальмары на пару",
      21: "Жареные кальмары в рыбном соусе",
      22: "Дополнительное яйцо",
      23: "Дополнительный суп из горькой дыни",
      24: "Жареный спринг-ролл (1 шт.)",
      25: "Дополнительное ребрышко гриль",
      26: "Дополнительное куриное бедро в рыбном соусе",
      27: "Дополнительная рваная курица",
      28: "Дополнительное хрустящее куриное бедро",
      29: "Газированные напитки в ассортименте",
      30: "Ред Булл",
      31: "Питьевая вода",
      32: "Минеральная вода без газа",
      33: "Свежий кокосовый сок",
      34: "Свежевыжатый апельсиновый сок",
      40: "Дополнительный рис",
      41: "Дополнительная говядина с овощами"
    }
  },

  hu: {
    total: "ÖSSZESEN",
    thanks: "Köszönjük, várjuk vissza!",
    beerFormat: "{brand} sör",
    items: {
      1: "Rizs grillezett sertésbordával és tojással",
      2: "Rizs tépett csirkehússal",
      3: "Rizs halszószban sült csirkecombbal",
      4: "Tenger gyümölcsei sült rizs",
      5: "Rizs ropogósra sült csirkecombbal",
      6: "Marhahús zöldségekkel pirítva, rizzsel",
      7: "Pirított tészta marhahússal",
      8: "Pirított tészta tenger gyümölcseivel",
      9: "Pirított üvegtészta marhahússal",
      10: "Pirított üvegtészta tenger gyümölcseivel",
      11: "Üvegtészta leves csirkehússal",
      12: "Üvegtészta leves marhahússal",
      13: "Üvegtészta leves tenger gyümölcseivel",
      14: "Kagylós rizskása",
      15: "Marhahúsos rizskása",
      16: "Gőzölt kagyló",
      17: "Pirított kagyló",
      18: "Gőzölt rák",
      19: "Halszószban sült rák",
      20: "Gőzölt tintahal",
      21: "Halszószban sült tintahal",
      22: "Plusz tojás",
      23: "Plusz keserűdinnye leves",
      24: "Sült tavaszi tekercs (1 db)",
      25: "Plusz grillezett borda",
      26: "Plusz halszószos csirkecomb",
      27: "Plusz tépett csirke",
      28: "Plusz ropogós csirkecomb",
      29: "Mindenféle üdítőital",
      30: "Red Bull",
      31: "Forrásvíz",
      32: "Szénsavmentes ásványvíz",
      33: "Friss kókuszvíz",
      34: "Friss narancslé",
      40: "Plusz rizs",
      41: "Plusz marhahús zöldségekkel"
    }
  },

  // Trung Phồn thể: 🇹🇼 TW
  tw: {
    total: "總計",
    thanks: "謝謝光臨，歡迎再來！",
    items: {
      1: "烤豬排加煎蛋飯",
      2: "雞絲飯",
      3: "魚露炸雞腿飯",
      4: "海鮮炒飯",
      5: "脆皮炸雞腿飯",
      6: "牛肉炒時蔬飯",
      7: "牛肉炒麵",
      8: "海鮮炒麵",
      9: "牛肉炒冬粉",
      10: "海鮮炒冬粉",
      11: "雞肉冬粉湯",
      12: "牛肉冬粉湯",
      13: "海鮮冬粉湯",
      14: "蛤蜊粥",
      15: "牛肉粥",
      16: "清蒸蛤蜊",
      17: "炒蛤蜊",
      18: "清蒸大蝦",
      19: "魚露炒大蝦",
      20: "清蒸魷魚",
      21: "魚露炒魷魚",
      22: "加煎蛋",
      23: "加苦瓜湯",
      24: "炸春捲 (1個)",
      25: "加烤豬排",
      26: "加魚露雞腿",
      27: "加雞絲",
      28: "加脆皮雞腿",
      29: "各式軟飲料",
      30: "紅牛",
      31: "飲用水",
      32: "無氣礦泉水",
      33: "新鮮椰子汁",
      34: "鮮榨橙汁",
      35: "拉魯啤酒",
      36: "胡達啤酒",
      37: "西貢啤酒",
      38: "老虎啤酒",
      39: "喜力啤酒",
      40: "加飯",
      41: "加牛肉炒時蔬"
    }
  },

  id: {
    total: "TOTAL",
    thanks: "Terima kasih & sampai jumpa lagi!",
    beerFormat: "Bir {brand}",
    items: {
      1: "Nasi iga babi bakar dengan telur",
      2: "Nasi ayam suwir",
      3: "Nasi paha ayam goreng saus ikan",
      4: "Nasi goreng seafood",
      5: "Nasi paha ayam goreng renyah",
      6: "Tumis daging sapi dengan sayuran dan nasi",
      7: "Mie goreng daging sapi",
      8: "Mie goreng seafood",
      9: "Sohun goreng daging sapi",
      10: "Sohun goreng seafood",
      11: "Sup sohun ayam",
      12: "Sup sohun daging sapi",
      13: "Sup sohun seafood",
      14: "Bubur kerang",
      15: "Bubur daging sapi",
      16: "Kerang kukus",
      17: "Kerang tumis",
      18: "Udang kukus",
      19: "Udang goreng saus ikan",
      20: "Cumi-cumi kukus",
      21: "Cumi-cumi goreng saus ikan",
      22: "Tambahan telur",
      23: "Tambahan sup pare",
      24: "Lumpia goreng (1 biji)",
      25: "Tambahan iga bakar",
      26: "Tambahan paha ayam saus ikan",
      27: "Tambahan ayam suwir",
      28: "Tambahan paha ayam renyah",
      29: "Aneka minuman ringan",
      30: "Red Bull",
      31: "Air mineral",
      32: "Air mineral tawar",
      33: "Air kelapa muda segar",
      34: "Jus jeruk segar",
      40: "Tambahan nasi",
      41: "Tambahan tumis daging sapi dengan sayuran"
    }
  },

  my: {
    total: "TOTAL",
    thanks: "Terima kasih & sila datang lagi!",
    beerFormat: "Bir {brand}",
    items: {
      1: "Nasi rusuk babi bakar dengan telur",
      2: "Nasi ayam siat",
      3: "Nasi paha ayam goreng sos ikan",
      4: "Nasi goreng makanan laut",
      5: "Nasi paha ayam goreng rangup",
      6: "Daging lembu goreng kilas dengan sayur dan nasi",
      7: "Mee goreng daging lembu",
      8: "Mee goreng makanan laut",
      9: "Suhun goreng daging lembu",
      10: "Suhun goreng makanan laut",
      11: "Sup suhun ayam",
      12: "Sup suhun daging lembu",
      13: "Sup suhun makanan laut",
      14: "Bubur remis",
      15: "Bubur daging lembu",
      16: "Remis dikukus",
      17: "Remis digoreng",
      18: "Udang dikukus",
      19: "Udang goreng sos ikan",
      20: "Sotong dikukus",
      21: "Sotong goreng sos ikan",
      22: "Telur tambahan",
      23: "Sup peria tambahan",
      24: "Popia goreng (1 biji)",
      25: "Rusuk bakar tambahan",
      26: "Paha ayam sos ikan tambahan",
      27: "Ayam siat tambahan",
      28: "Paha ayam rangup tambahan",
      29: "Pelbagai jenis minuman ringan",
      30: "Red Bull",
      31: "Air mineral",
      32: "Air mineral semula jadi",
      33: "Air kelapa segar",
      34: "Jus oren segar",
      40: "Nasi tambahan",
      41: "Tambahan daging lembu goreng kilas dengan sayur"
    }
  },

  // Thuần tiếng Hindi (Devanagari, không kèm tiếng Anh trong ngoặc)
  in: {
    total: "कुल योग",
    thanks: "धन्यवाद, फिर पधारें!",
    items: {
      1: "ग्रिल्ड पोर्क चॉप्स और अंडा चावल",
      2: "रेशेदार चिकन चावल",
      3: "फिश सॉस तली चिकन टांग चावल",
      4: "सीफूड फ्राइड राइस",
      5: "कुरकुरी तली चिकन टांग चावल",
      6: "सब्ज़ियों के साथ भुना बीफ़ और चावल",
      7: "बीफ़ फ्राइड नूडल्स",
      8: "सीफूड फ्राइड नूडल्स",
      9: "बीफ़ भुने ग्लास नूडल्स",
      10: "सीफूड भुने ग्लास नूडल्स",
      11: "चिकन ग्लास नूडल सूप",
      12: "बीफ़ ग्लास नूडल सूप",
      13: "सीफूड ग्लास नूडल सूप",
      14: "क्लैम चावल दलिया",
      15: "बीफ़ चावल दलिया",
      16: "उबले हुए क्लैम",
      17: "भुने हुए क्लैम",
      18: "उबले हुए झींगे",
      19: "फिश सॉस तले झींगे",
      20: "उबला हुआ स्क्विड",
      21: "फिश सॉस तला स्क्विड",
      22: "अतिरिक्त अंडा",
      23: "अतिरिक्त करेला सूप",
      24: "तला स्प्रिंग रोल (1 पीस)",
      25: "अतिरिक्त ग्रिल्ड पोर्क चॉप",
      26: "अतिरिक्त फिश सॉस चिकन टांग",
      27: "अतिरिक्त रेशेदार चिकन",
      28: "अतिरिक्त कुरकुरी चिकन टांग",
      29: "विभिन्न शीतल पेय",
      30: "रेड बुल",
      31: "बोतलबंद पानी",
      32: "सादा मिनरल वाटर",
      33: "ताज़ा नारियल पानी",
      34: "ताज़ा संतरे का रस",
      35: "लारू बियर",
      36: "हुडा बियर",
      37: "साइगॉन बियर",
      38: "टाइगर बियर",
      39: "हाइनेकेन बियर",
      40: "अतिरिक्त चावल",
      41: "अतिरिक्त सब्ज़ियों के साथ भुना बीफ़"
    }
  },

  fi: {
    total: "YHTEENSÄ",
    thanks: "Kiitos ja tervetuloa uudelleen!",
    beerFormat: "{brand}-olut",
    items: {
      1: "Riisiä, grillattua porsaankylkeä ja kananmuna",
      2: "Riisiä ja revittyä kanaa",
      3: "Riisiä ja kanankoipi kalakastikkeessa",
      4: "Paistettua riisiä merenelävillä",
      5: "Riisiä ja rapeaa kanankoipea",
      6: "Paistettua nautaa ja vihanneksia riisillä",
      7: "Paistettuja nuudeleita ja nautaa",
      8: "Paistettuja nuudeleita ja mereneläviä",
      9: "Paistettua lasinuudelia ja nautaa",
      10: "Paistettua lasinuudelia ja mereneläviä",
      11: "Lasinuudelikeitto kanalla",
      12: "Lasinuudelikeitto naudalla",
      13: "Lasinuudelikeitto merenelävillä",
      14: "Simpukkariisipuuro",
      15: "Naudanlihariisipuuro",
      16: "Höyrytetyt simpukat",
      17: "Paistetut simpukat",
      18: "Höyrytetyt katkaravut",
      19: "Paistetut katkaravut kalakastikkeessa",
      20: "Höyrytetty mustekala",
      21: "Paistettu mustekala kalakastikkeessa",
      22: "Ylimääräinen kananmuna",
      23: "Ylimääräinen karvaskurkkukeitto",
      24: "Paistettu kevätkääryle (1 kpl)",
      25: "Ylimääräinen grillattu kylki",
      26: "Ylimääräinen kanankoipi kalakastikkeessa",
      27: "Ylimääräinen revitty kana",
      28: "Ylimääräinen rapea kanankoipi",
      29: "Virvoitusjuomat laidasta laitaan",
      30: "Red Bull",
      31: "Lähdevesi",
      32: "Hiilihapoton kivennäisvesi",
      33: "Tuore kookosvesi",
      34: "Tuore appelsiinimehu",
      40: "Lisäriisi",
      41: "Ylimääräinen paistettu nauta vihanneksilla"
    }
  },

  // Dùng chung cho: 🇳🇱 NL, 🇧🇪 BE
  nl: {
    total: "TOTAAL",
    thanks: "Bedankt en graag tot ziens!",
    beerFormat: "{brand} bier",
    items: {
      1: "Rijst met gegrilde varkensribben en ei",
      2: "Rijst met geplukte kip",
      3: "Rijst met kippenbout in vissaus",
      4: "Gebakken rijst met zeevruchten",
      5: "Rijst met krokante kippenbout",
      6: "Roergebakken rundvlees met groenten en rijst",
      7: "Gebakken mie met rundvlees",
      8: "Gebakken mie met zeevruchten",
      9: "Gebakken glasnoedels met rundvlees",
      10: "Gebakken glasnoedels met zeevruchten",
      11: "Glasnoedelsoep met kip",
      12: "Glasnoedelsoep met rundvlees",
      13: "Glasnoedelsoep met zeevruchten",
      14: "Rijstcongee met kokkels",
      15: "Rijstcongee met rundvlees",
      16: "Gestoomde kokkels",
      17: "Roergebakken kokkels",
      18: "Gestoomde garnalen",
      19: "Gebakken garnalen in vissaus",
      20: "Gestoomde inktvis",
      21: "Gebakken inktvis in vissaus",
      22: "Extra ei",
      23: "Extra bitterkomkommersoep",
      24: "Gebakken loempia (1 st.)",
      25: "Extra gegrilde sparerib",
      26: "Extra kippenbout in vissaus",
      27: "Extra geplukte kip",
      28: "Extra krokante kippenbout",
      29: "Frisdranken naar keuze",
      30: "Red Bull",
      31: "Bronwater",
      32: "Stil mineraalwater",
      33: "Vers kokoswater",
      34: "Vers geperst sinaasappelsap",
      40: "Extra rijst",
      41: "Extra roergebakken rundvlees met groenten"
    }
  },

  se: {
    total: "TOTALT",
    thanks: "Tack och välkommen åter!",
    beerFormat: "{brand}-öl",
    items: {
      1: "Ris med grillade fläskkotletter och ägg",
      2: "Ris med strimlad kyckling",
      3: "Ris med kycklingklubba i fisksås",
      4: "Stekt ris med skaldjur",
      5: "Ris med krispig kycklingklubba",
      6: "Wokat nötkött med grönsaker och ris",
      7: "Stekta nudlar med nötkött",
      8: "Stekta nudlar med skaldjur",
      9: "Stekta glasnudlar med nötkött",
      10: "Stekta glasnudlar med skaldjur",
      11: "Glasnudelsoppa med kyckling",
      12: "Glasnudelsoppa med nötkött",
      13: "Glasnudelsoppa med skaldjur",
      14: "Risgröt med musslor",
      15: "Risgröt med nötkött",
      16: "Ångkokta musslor",
      17: "Wokade musslor",
      18: "Ångkokta räkor",
      19: "Stekta räkor i fisksås",
      20: "Ångkokt bläckfisk",
      21: "Stekt bläckfisk i fisksås",
      22: "Extra ägg",
      23: "Extra bittermelonsoppa",
      24: "Friterad vårrulle (1 st)",
      25: "Extra grillad kotlett",
      26: "Extra kycklingklubba i fisksås",
      27: "Extra strimlad kyckling",
      28: "Extra krispig kycklingklubba",
      29: "Läskedrycker av alla slag",
      30: "Red Bull",
      31: "Källvatten",
      32: "Stilla mineralvatten",
      33: "Färskt kokosvatten",
      34: "Färskpressad apelsinjuice",
      40: "Extra ris",
      41: "Extra wokat nötkött med grönsaker"
    }
  }
};

// Danh sách 24 nút cờ hiển thị trên bill (thứ tự giữ nguyên 100%, nước cùng ngôn ngữ trỏ chung `pack`)
export const LANG_BUTTONS = [
  { code: "vi", flag: "🇻🇳", label: "VN", pack: "vi" },
  { code: "en", flag: "🇺🇸", label: "EN", pack: "en" },
  { code: "fr", flag: "🇫🇷", label: "FR", pack: "fr" },
  { code: "kr", flag: "🇰🇷", label: "KR", pack: "kr" },
  { code: "jp", flag: "🇯🇵", label: "JP", pack: "jp" },
  { code: "th", flag: "🇹🇭", label: "TH", pack: "th" },
  { code: "it", flag: "🇮🇹", label: "IT", pack: "it" },
  { code: "pt", flag: "🇵🇹", label: "PT", pack: "pt" },
  { code: "es", flag: "🇪🇸", label: "ES", pack: "es" },
  { code: "cn", flag: "🇨🇳", label: "CN", pack: "cn" },
  { code: "de", flag: "🇩🇪", label: "DE", pack: "de" },
  { code: "ru", flag: "🇷🇺", label: "RU", pack: "ru" },
  { code: "be", flag: "🇧🇪", label: "BE", pack: "nl" },
  { code: "hu", flag: "🇭🇺", label: "HU", pack: "hu" },
  { code: "at", flag: "🇦🇹", label: "AT", pack: "de" },
  { code: "tw", flag: "🇹🇼", label: "TW", pack: "tw" },
  { code: "sg", flag: "🇸🇬", label: "SG", pack: "en" },
  { code: "id", flag: "🇮🇩", label: "ID", pack: "id" },
  { code: "my", flag: "🇲🇾", label: "MY", pack: "my" },
  { code: "in", flag: "🇮🇳", label: "IN", pack: "in" },
  { code: "fi", flag: "🇫🇮", label: "FI", pack: "fi" },
  { code: "nl", flag: "🇳🇱", label: "NL", pack: "nl" },
  { code: "se", flag: "🇸🇪", label: "SE", pack: "se" },
  { code: "ch", flag: "🇨🇭", label: "CH", pack: "de" }
];

// Đóng băng items theo từng gói để các cờ dùng chung (ví dụ en & sg, de & at & ch) trỏ chung 1 object nhẹ RAM
const resolvedItemsByPack = {};
for (const [packKey, packData] of Object.entries(LANG_PACKS)) {
  if (packKey === "vi") {
    resolvedItemsByPack[packKey] = {};
    continue;
  }
  const beers = packData.beerFormat ? buildBeers(packData.beerFormat) : {};
  resolvedItemsByPack[packKey] = {
    ...beers,
    ...packData.items
  };
}

export const dict = {};
for (const btn of LANG_BUTTONS) {
  const packData = LANG_PACKS[btn.pack];
  dict[btn.code] = {
    flag: btn.flag,
    total: packData.total,
    thanks: packData.thanks,
    items: resolvedItemsByPack[btn.pack]
  };
}

// Hàm tự động kiểm tra tính toàn vẹn giữa menu.js và dict.js
// Bắt lỗi ngay lập tức khi thêm món mới mà quên dịch, sai ID hoặc để chuỗi rỗng
export function validateMenuDict(menuGroups) {
  const issues = [];
  const menuItems = Array.isArray(menuGroups) ? menuGroups.flatMap(g => g.items || []) : [];
  const validIds = new Set(menuItems.map(i => Number(i.id)));

  // 1. Kiểm tra ánh xạ 24 nút cờ
  const seenCodes = new Set();
  for (const btn of LANG_BUTTONS) {
    if (seenCodes.has(btn.code)) {
      issues.push(`Trùng mã cờ "${btn.code}" trong LANG_BUTTONS.`);
    }
    seenCodes.add(btn.code);
    if (!LANG_PACKS[btn.pack]) {
      issues.push(`Cờ "${btn.code}" trỏ tới gói ngôn ngữ không tồn tại "${btn.pack}".`);
    }
  }

  // 2. Kiểm tra từng gói ngôn ngữ so với danh sách món trong menu.js
  for (const [packKey, packData] of Object.entries(LANG_PACKS)) {
    if (!packData.total || !packData.thanks) {
      issues.push(`Gói [${packKey}] thiếu "total" hoặc "thanks".`);
    }
    if (packKey === "vi") continue;

    const items = resolvedItemsByPack[packKey] || {};
    const missingIds = [];
    const emptyIds = [];
    const extraIds = [];

    for (const id of validIds) {
      if (!Object.prototype.hasOwnProperty.call(items, id)) {
        missingIds.push(id);
      } else if (typeof items[id] !== "string" || !items[id].trim()) {
        emptyIds.push(id);
      }
    }

    for (const rawId of Object.keys(items)) {
      if (!validIds.has(Number(rawId))) {
        extraIds.push(rawId);
      }
    }

    if (missingIds.length) {
      issues.push(`Gói [${packKey}] thiếu bản dịch cho ID: ${missingIds.join(", ")}`);
    }
    if (emptyIds.length) {
      issues.push(`Gói [${packKey}] có bản dịch rỗng ở ID: ${emptyIds.join(", ")}`);
    }
    if (extraIds.length) {
      issues.push(`Gói [${packKey}] dư ID không có trong menu.js: ${extraIds.join(", ")}`);
    }
  }

  if (issues.length > 0) {
    console.error("[dict] Phát hiện lỗi cấu hình đa ngôn ngữ:\n - " + issues.join("\n - "));
  }
  return issues;
}
