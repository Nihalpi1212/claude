import type { MenuItem, OptionGroup, Vendor, MenuSection } from './types';

const o = (id: string, en: string, ar: string, price = 0) => ({ id, name: { en, ar }, price });

// ---- reusable option groups -------------------------------------------------
const size: OptionGroup = {
  id: 'size', title: { en: 'Size', ar: 'الحجم' }, required: true, max: 1,
  options: [o('s', 'Regular', 'عادي'), o('m', 'Large', 'كبير', 4), o('l', 'Family', 'عائلي', 12)],
};
const spice: OptionGroup = {
  id: 'spice', title: { en: 'Spice level', ar: 'درجة الحرارة' }, required: true, max: 1,
  options: [o('mild', 'Mild', 'خفيف'), o('med', 'Medium', 'وسط'), o('hot', 'Hot 🔥', 'حار 🔥')],
};
const sides: OptionGroup = {
  id: 'sides', title: { en: 'Add sides', ar: 'أضف جانبية' }, max: 3,
  options: [o('fries', 'French fries', 'بطاطس مقلية', 8), o('salad', 'Fattoush salad', 'سلطة فتوش', 7), o('hummus', 'Hummus', 'حمص', 6), o('drink', 'Soft drink', 'مشروب غازي', 4)],
};
const drinkSize: OptionGroup = {
  id: 'dsize', title: { en: 'Size', ar: 'الحجم' }, required: true, max: 1,
  options: [o('r', 'Regular', 'عادي'), o('l', 'Large', 'كبير', 3)],
};
const milk: OptionGroup = {
  id: 'milk', title: { en: 'Milk', ar: 'الحليب' }, max: 1,
  options: [o('full', 'Full fat', 'كامل الدسم'), o('oat', 'Oat', 'شوفان', 3), o('almond', 'Almond', 'لوز', 3)],
};

type Tuple = [string, string, number, string, string, string, Partial<MenuItem>?];
const it = (key: string, rows: Tuple[]): MenuItem[] =>
  rows.map(([en, ar, price, emoji, dEn, dAr, extra], i) => ({
    id: `${key}${i + 1}`, name: { en, ar }, desc: { en: dEn, ar: dAr }, price, emoji, ...extra,
  }));
const sec = (id: string, en: string, ar: string, items: MenuItem[]): MenuSection => ({ id, title: { en, ar }, items });

export const vendors: Vendor[] = [
  {
    id: 'majlis', name: { en: 'Al Majlis Kitchen', ar: 'مطبخ المجلس' }, tagline: { en: 'Authentic Qatari home cooking', ar: 'أكل قطري أصيل' },
    categoryId: 'qatari', cuisine: { en: 'Qatari · Gulf', ar: 'قطري · خليجي' }, emoji: '🍛', colors: ['#F6C177', '#D9822B'],
    rating: 4.8, ratingCount: 2314, etaMin: 30, etaMax: 45, deliveryFee: 6, minOrder: 30, hours: [10, 24], area: { en: 'Msheireb', ar: 'مشيرب' },
    promo: { en: '20% off weekend feasts', ar: 'خصم 20٪ على وجبات العطلة' },
    menu: [
      sec('mains', 'Mains', 'الأطباق الرئيسية', it('maj', [
        ['Chicken Machboos', 'مجبوس دجاج', 38, '🍛', 'Fragrant spiced rice with slow-cooked chicken and dried lime', 'أرز متبل بالبهارات مع دجاج مطبوخ ببطء ولومي', { popular: true, groups: [size, spice] }],
        ['Lamb Machboos', 'مجبوس لحم', 54, '🍖', 'Tender lamb on saffron rice with caramelised onions', 'لحم طري على أرز بالزعفران مع بصل مكرمل', { popular: true, groups: [size, spice] }],
        ['Madrouba', 'مضروبة', 36, '🥘', 'Creamy spiced rice porridge with chicken, a Gulf classic', 'أرز كريمي متبل مع دجاج، من أشهر الأكلات الخليجية', { groups: [size] }],
        ['Harees', 'هريس', 32, '🍲', 'Slow-cooked wheat and lamb, finished with ghee', 'قمح ولحم مطبوخ ببطء مع السمن'],
        ['Thareed', 'ثريد', 40, '🍜', 'Bread soaked in rich lamb and vegetable stew', 'خبز مغموس بمرق اللحم والخضار'],
      ])),
      sec('sides', 'Sides & Salads', 'جانبيات وسلطات', it('majs', [
        ['Fattoush Salad', 'سلطة فتوش', 16, '🥗', 'Crisp greens, sumac, pomegranate molasses', 'خضار مقرمشة مع سماق ودبس الرمان'],
        ['Hummus', 'حمص', 14, '🧆', 'Silky chickpea dip with olive oil', 'حمص ناعم بزيت الزيتون'],
        ['Laban Cup', 'كوب لبن', 6, '🥛', 'Chilled salted yogurt drink', 'لبن بارد مملح'],
      ])),
      sec('sweet', 'Desserts', 'حلويات', it('majd', [
        ['Luqaimat', 'لقيمات', 18, '🍩', 'Golden dumplings drizzled with date syrup', 'كرات ذهبية مع دبس التمر', { popular: true }],
        ['Umm Ali', 'أم علي', 20, '🍮', 'Warm bread pudding with nuts and cream', 'حلى دافئ بالمكسرات والقشطة'],
      ])),
    ],
  },
  {
    id: 'shawarma', name: { en: 'Shawarma Station', ar: 'محطة الشاورما' }, tagline: { en: 'Stacked, sliced, wrapped fresh', ar: 'شاورما طازجة' },
    categoryId: 'shawarma', cuisine: { en: 'Lebanese · Grills', ar: 'لبناني · مشاوي' }, emoji: '🌯', colors: ['#FFD28A', '#F29B38'],
    rating: 4.7, ratingCount: 5120, etaMin: 15, etaMax: 25, deliveryFee: 0, minOrder: 15, hours: [11, 3], area: { en: 'Al Sadd', ar: 'السد' },
    promo: { en: 'Free delivery', ar: 'توصيل مجاني' },
    menu: [
      sec('wraps', 'Wraps', 'سندويشات', it('sh', [
        ['Chicken Shawarma', 'شاورما دجاج', 10, '🌯', 'Garlic sauce, pickles and crispy fries inside', 'ثوم ومخلل وبطاطس داخل الساندويش', { popular: true, groups: [{ ...size, options: [o('s', 'Regular', 'عادي'), o('m', 'Large', 'كبير', 3)] }, sides] }],
        ['Beef Shawarma', 'شاورما لحم', 13, '🥙', 'Tahini, tomato, parsley and onion', 'طحينة وطماطم وبقدونس وبصل', { popular: true }],
        ['Falafel Wrap', 'ساندويش فلافل', 8, '🧆', 'Crunchy falafel with tahini and veggies', 'فلافل مقرمشة مع طحينة وخضار'],
        ['Mixed Grill Wrap', 'ساندويش مشاوي', 15, '🥙', 'Shish tawook and kofta with garlic', 'شيش طاووق وكفتة مع ثوم'],
      ])),
      sec('plat', 'Platters', 'وجبات', it('shp', [
        ['Shawarma Platter', 'صحن شاورما', 28, '🍽️', 'Rice, fries, salad, garlic and hummus', 'أرز وبطاطس وسلطة وثوم وحمص', { groups: [sides] }],
        ['Mixed Grill', 'مشاوي مشكلة', 52, '🍢', 'Tawook, kofta and lamb skewers', 'شيش طاووق وكفتة وأسياخ لحم', { groups: [size] }],
      ])),
      sec('drinks', 'Drinks', 'مشروبات', it('shd', [
        ['Fresh Lemon Mint', 'ليمون بالنعناع', 12, '🍹', 'Blended with fresh mint', 'طازج مع النعناع', { groups: [drinkSize] }],
        ['Ayran', 'عيران', 5, '🥛', 'Cold salted yogurt', 'لبن بارد مملح'],
      ])),
    ],
  },
  {
    id: 'karak', name: { en: 'Karak House', ar: 'بيت الكرك' }, tagline: { en: 'Chai the Doha way', ar: 'شاي كرك على أصوله' },
    categoryId: 'coffee', cuisine: { en: 'Karak · Snacks', ar: 'كرك · سناكات' }, emoji: '☕', colors: ['#E7D2BE', '#A47551'],
    rating: 4.9, ratingCount: 8934, etaMin: 10, etaMax: 20, deliveryFee: 3, minOrder: 10, hours: [5, 4], area: { en: 'Al Waab', ar: 'الوعب' },
    promo: { en: 'Buy 5 karak, get 1 free', ar: 'اشتر 5 كرك واحصل على 1 مجاناً' },
    menu: [
      sec('karak', 'Karak & Tea', 'كرك وشاي', it('kr', [
        ['Karak Chai', 'شاي كرك', 3, '☕', 'Strong tea, evaporated milk, cardamom', 'شاي قوي وحليب مبخر وهيل', { popular: true, groups: [drinkSize] }],
        ['Saffron Karak', 'كرك بالزعفران', 6, '🧡', 'Karak with a golden saffron finish', 'كرك مع لمسة زعفران', { popular: true, groups: [drinkSize] }],
        ['Ginger Karak', 'كرك بالزنجبيل', 4, '🫚', 'Warming ginger kick', 'نكهة زنجبيل دافئة', { groups: [drinkSize] }],
        ['Arabic Coffee (Dallah)', 'قهوة عربية (دلة)', 22, '🫖', 'Cardamom coffee served with dates', 'قهوة بالهيل مع التمر'],
      ])),
      sec('snacks', 'Bites', 'سناكات', it('krs', [
        ['Paratha Roll', 'رول باراثا', 8, '🫓', 'Flaky paratha with cheese and egg', 'باراثا مقرمشة بالجبن والبيض', { popular: true }],
        ['Cheese Samosa (4)', 'سمبوسة جبن (4)', 10, '🥟', 'Crispy golden pockets', 'مقرمشة وذهبية'],
        ['Chips Oman Sandwich', 'ساندويش شيبس عمان', 4, '🥪', 'The iconic Gulf snack', 'السناك الخليجي الشهير'],
      ])),
    ],
  },
  {
    id: 'burger', name: { en: 'Burger Forge', ar: 'برغر فورج' }, tagline: { en: 'Smashed. Stacked. Done right.', ar: 'برغر مشوي على أصوله' },
    categoryId: 'burgers', cuisine: { en: 'American · Burgers', ar: 'أمريكي · برغر' }, emoji: '🍔', colors: ['#FFB199', '#F0634B'],
    rating: 4.6, ratingCount: 3881, etaMin: 25, etaMax: 35, deliveryFee: 5, minOrder: 25, hours: [11, 2], area: { en: 'The Pearl-Qatar', ar: 'اللؤلؤة قطر' },
    promo: { en: '30% off first order', ar: 'خصم 30٪ على أول طلب' },
    menu: [
      sec('burgers', 'Burgers', 'برغر', it('bf', [
        ['The Forge Classic', 'فورج كلاسيك', 32, '🍔', 'Double smashed beef, American cheese, house sauce', 'لحم مفروم مزدوج وجبنة أمريكية وصوص خاص', { popular: true, groups: [{ id: 'combo', title: { en: 'Make it a combo', ar: 'اجعلها وجبة' }, max: 1, options: [o('none', 'Burger only', 'برغر فقط'), o('combo', 'Fries + drink', 'بطاطس + مشروب', 12)] }] }],
        ['Truffle Mushroom', 'برغر الفطر والتروفل', 38, '🍄', 'Swiss cheese, sautéed mushrooms, truffle mayo', 'جبنة سويسرية وفطر مع صوص التروفل'],
        ['Crispy Chicken', 'دجاج مقرمش', 28, '🍗', 'Buttermilk fried chicken, pickles, slaw', 'دجاج مقرمش مع مخلل وكولسلو', { popular: true }],
        ['Halloumi Veggie', 'برغر حلوم نباتي', 26, '🧀', 'Grilled halloumi, roasted peppers, pesto', 'حلوم مشوي وفلفل محمص وبيستو'],
      ])),
      sec('sides', 'Sides', 'جانبيات', it('bfs', [
        ['Loaded Fries', 'بطاطس محمّلة', 18, '🍟', 'Cheese sauce, jalapeño, crispy onions', 'صوص جبنة وهالبينو وبصل مقرمش'],
        ['Onion Rings', 'حلقات بصل', 14, '🧅', 'Beer-battered and crisp', 'مقرمشة ومقلية'],
        ['Vanilla Shake', 'ميلك شيك فانيلا', 16, '🥤', 'Thick and creamy', 'كثيف وكريمي'],
      ])),
    ],
  },
  {
    id: 'napoli', name: { en: 'Napoli Slice', ar: 'نابولي سلايس' }, tagline: { en: 'Wood-fired Neapolitan pizza', ar: 'بيتزا نابولي بالحطب' },
    categoryId: 'pizza', cuisine: { en: 'Italian · Pizza', ar: 'إيطالي · بيتزا' }, emoji: '🍕', colors: ['#FFC4C4', '#E5484D'],
    rating: 4.7, ratingCount: 1902, etaMin: 30, etaMax: 40, deliveryFee: 7, minOrder: 35, hours: [12, 1], area: { en: 'Lusail', ar: 'لوسيل' },
    busy: true,
    menu: [
      sec('pizza', 'Pizzas', 'بيتزا', it('np', [
        ['Margherita', 'مارغريتا', 34, '🍕', 'San Marzano tomato, fior di latte, basil', 'طماطم سان مارزانو وجبنة وريحان', { popular: true, groups: [{ id: 'psize', title: { en: 'Size', ar: 'الحجم' }, required: true, max: 1, options: [o('m', '10"', '10 إنش'), o('l', '12"', '12 إنش', 8), o('xl', '16"', '16 إنش', 18)] }] }],
        ['Pepperoni', 'ببروني', 42, '🍕', 'Spicy beef pepperoni, mozzarella, chilli oil', 'ببروني لحم حار وموزاريلا وزيت حار', { popular: true }],
        ['Quattro Formaggi', 'أربع أجبان', 46, '🧀', 'Mozzarella, gorgonzola, parmesan, ricotta', 'موزاريلا وغورغونزولا وبارميزان وريكوتا'],
        ['Truffle Funghi', 'فطر وتروفل', 48, '🍄', 'Cream, wild mushrooms, truffle oil', 'كريمة وفطر بري وزيت تروفل'],
      ])),
      sec('pasta', 'Pasta & Starters', 'معكرونة ومقبلات', it('npp', [
        ['Penne Arrabbiata', 'بيني أرابياتا', 30, '🍝', 'Spicy tomato, garlic, parsley', 'صلصة طماطم حارة وثوم وبقدونس'],
        ['Garlic Dough Balls', 'كرات عجين بالثوم', 16, '🥖', 'Warm with herb butter', 'دافئة بزبدة الأعشاب'],
        ['Tiramisu', 'تيراميسو', 22, '🍰', 'Mascarpone, espresso, cocoa', 'ماسكاربوني وإسبريسو وكاكاو'],
      ])),
    ],
  },
  {
    id: 'tokyo', name: { en: 'Tokyo Bay', ar: 'طوكيو باي' }, tagline: { en: 'Sushi & ramen, made to order', ar: 'سوشي ورامن طازج' },
    categoryId: 'asian', cuisine: { en: 'Japanese · Sushi', ar: 'ياباني · سوشي' }, emoji: '🍣', colors: ['#C9E4FF', '#5B9BE6'],
    rating: 4.8, ratingCount: 1450, etaMin: 35, etaMax: 50, deliveryFee: 8, minOrder: 50, hours: [12, 23], area: { en: 'West Bay', ar: 'الخليج الغربي' },
    menu: [
      sec('sushi', 'Sushi', 'سوشي', it('tk', [
        ['Salmon Nigiri (6)', 'نيغيري سلمون (6)', 44, '🍣', 'Hand-pressed with fresh Norwegian salmon', 'سلمون نرويجي طازج', { popular: true }],
        ['Dragon Roll (8)', 'دراغون رول (8)', 52, '🐉', 'Prawn tempura, avocado, eel sauce', 'روبيان تمبورا وأفوكادو وصوص الأنقليس', { popular: true }],
        ['Spicy Tuna Roll (8)', 'رول تونة حارة (8)', 46, '🍙', 'Tuna, chilli mayo, cucumber', 'تونة ومايونيز حار وخيار'],
        ['Chef Platter (24)', 'طبق الشيف (24)', 120, '🍱', 'Assorted nigiri and rolls for sharing', 'تشكيلة نيغيري ورولات للمشاركة'],
      ])),
      sec('hot', 'Hot Kitchen', 'المطبخ الساخن', it('tkh', [
        ['Tonkotsu Ramen', 'رامن تونكوتسو', 48, '🍜', '12-hour pork broth, chashu, soft egg', 'مرق 12 ساعة مع لحم وبيض', { groups: [spice] }],
        ['Chicken Katsu Curry', 'كاتسو دجاج بالكاري', 42, '🍛', 'Crispy cutlet, Japanese curry, rice', 'دجاج مقرمش وكاري ياباني وأرز'],
        ['Edamame', 'إدامامي', 16, '🫛', 'Steamed, sea salt', 'مطهو على البخار بملح البحر'],
      ])),
    ],
  },
  {
    id: 'spice', name: { en: 'Spice Route', ar: 'طريق التوابل' }, tagline: { en: 'Dum biryani & North Indian curries', ar: 'برياني ومأكولات هندية' },
    categoryId: 'indian', cuisine: { en: 'Indian · Biryani', ar: 'هندي · برياني' }, emoji: '🍲', colors: ['#FFD9A8', '#D9822B'],
    rating: 4.5, ratingCount: 4210, etaMin: 25, etaMax: 40, deliveryFee: 4, minOrder: 25, hours: [11, 1], area: { en: 'Abu Hamour', ar: 'أبو هامور' },
    promo: { en: 'Free naan on orders 50+', ar: 'خبز نان مجاني للطلبات 50+' },
    menu: [
      sec('biryani', 'Biryani', 'برياني', it('sp', [
        ['Hyderabadi Chicken Biryani', 'برياني دجاج حيدر آبادي', 26, '🍛', 'Dum-cooked basmati with raita', 'أرز بسمتي مطبوخ بالدم مع رايتا', { popular: true, groups: [spice, size] }],
        ['Lamb Dum Biryani', 'برياني لحم', 34, '🍖', 'Slow-cooked with saffron and fried onion', 'مطبوخ ببطء بالزعفران والبصل المقلي', { groups: [spice] }],
      ])),
      sec('curry', 'Curries & Breads', 'كاري وخبز', it('spc', [
        ['Butter Chicken', 'دجاج بالزبدة', 30, '🍗', 'Creamy tomato-butter gravy', 'صلصة طماطم وزبدة كريمية', { popular: true, groups: [spice] }],
        ['Paneer Tikka Masala', 'بانير تيكا ماسالا', 28, '🧀', 'Charred paneer, rich masala', 'جبن بانير مشوي مع ماسالا'],
        ['Garlic Naan', 'نان بالثوم', 6, '🫓', 'Tandoor-baked', 'مخبوز في التندور'],
        ['Mango Lassi', 'مانجو لاسي', 14, '🥭', 'Thick yogurt and Alphonso mango', 'زبادي ومانجو ألفونسو'],
      ])),
    ],
  },
  {
    id: 'souq', name: { en: 'Sweet Souq', ar: 'سوق الحلويات' }, tagline: { en: 'Kunafa, baklava & Arabic sweets', ar: 'كنافة وبقلاوة وحلويات عربية' },
    categoryId: 'desserts', cuisine: { en: 'Arabic Sweets', ar: 'حلويات عربية' }, emoji: '🧁', colors: ['#FFD3EA', '#E667A8'],
    rating: 4.9, ratingCount: 2760, etaMin: 20, etaMax: 30, deliveryFee: 5, minOrder: 20, hours: [10, 1], area: { en: 'Al Mansoura', ar: 'المنصورة' },
    menu: [
      sec('sweets', 'Signature', 'المميزة', it('sq', [
        ['Cheese Kunafa', 'كنافة بالجبن', 24, '🧇', 'Warm, stretchy and syrup-soaked', 'دافئة وممطوطة بالقطر', { popular: true }],
        ['Pistachio Baklava (500g)', 'بقلاوة فستق (500 غ)', 58, '🥮', 'Layered filo with Aleppo pistachio', 'عجينة رقيقة بفستق حلبي', { popular: true }],
        ['Date & Tahini Cake', 'كيكة التمر والطحينة', 20, '🍰', 'Moist, with salted caramel', 'طرية مع كراميل مملح'],
        ['Luqaimat Box', 'علبة لقيمات', 22, '🍩', 'Crispy dumplings, date syrup', 'كرات مقرمشة مع دبس التمر'],
        ['Gift Box (assorted)', 'علبة هدايا (مشكلة)', 85, '🎁', 'A premium selection, beautifully boxed', 'تشكيلة فاخرة بعلبة أنيقة'],
      ])),
    ],
  },
  {
    id: 'greenbowl', name: { en: 'Green Bowl', ar: 'غرين بول' }, tagline: { en: 'Fresh bowls & cold-pressed juice', ar: 'أطباق صحية وعصائر طازجة' },
    categoryId: 'healthy', cuisine: { en: 'Healthy · Salads', ar: 'صحي · سلطات' }, emoji: '🥗', colors: ['#C8F0D2', '#3DB86B'],
    rating: 4.7, ratingCount: 980, etaMin: 20, etaMax: 30, deliveryFee: 5, minOrder: 25, hours: [8, 22], area: { en: 'Aspire Zone', ar: 'أسباير' },
    menu: [
      sec('bowls', 'Bowls', 'أطباق', it('gb', [
        ['Protein Power Bowl', 'طبق البروتين', 36, '🥗', 'Grilled chicken, quinoa, avocado, tahini', 'دجاج مشوي وكينوا وأفوكادو وطحينة', { popular: true, groups: [{ id: 'add', title: { en: 'Boost it', ar: 'أضف' }, max: 3, options: [o('egg', 'Soft egg', 'بيض مسلوق', 4), o('avo', 'Extra avocado', 'أفوكادو إضافي', 6), o('feta', 'Feta', 'جبنة فيتا', 5)] }] }],
        ['Falafel Buddha Bowl', 'طبق فلافل نباتي', 30, '🥙', 'Falafel, roasted veg, hummus, greens', 'فلافل وخضار مشوية وحمص وورقيات'],
        ['Salmon Poke', 'بوكي سلمون', 42, '🐟', 'Sushi rice, salmon, edamame, ponzu', 'أرز سوشي وسلمون وإدامامي وبونزو'],
      ])),
      sec('juice', 'Juice & Smoothies', 'عصائر وسموذي', it('gbj', [
        ['Green Detox Juice', 'عصير ديتوكس أخضر', 18, '🥬', 'Cold-pressed apple, spinach, ginger', 'تفاح وسبانخ وزنجبيل معصور على البارد'],
        ['Acai Smoothie', 'سموذي أساي', 24, '🫐', 'Acai, banana, berries, granola', 'أساي وموز وتوت وجرانولا'],
      ])),
    ],
  },
  {
    id: 'beantheory', name: { en: 'Bean Theory', ar: 'بين ثيوري' }, tagline: { en: 'Specialty coffee roasters', ar: 'محمصة قهوة مختصة' },
    categoryId: 'coffee', cuisine: { en: 'Coffee · Pastries', ar: 'قهوة · معجنات' }, emoji: '🫘', colors: ['#D8C3AE', '#6F4E37'],
    rating: 4.8, ratingCount: 3120, etaMin: 15, etaMax: 25, deliveryFee: 4, minOrder: 15, hours: [7, 23], area: { en: 'Msheireb', ar: 'مشيرب' },
    menu: [
      sec('coffee', 'Coffee', 'قهوة', it('bt', [
        ['Flat White', 'فلات وايت', 16, '☕', 'Double ristretto, silky milk', 'ريستريتو مزدوج وحليب ناعم', { popular: true, groups: [drinkSize, milk] }],
        ['Spanish Latte', 'سبانش لاتيه', 19, '🥛', 'Sweetened condensed milk, espresso', 'حليب مكثف وإسبريسو', { popular: true, groups: [drinkSize, milk] }],
        ['V60 Pour Over', 'في 60 مقطّرة', 22, '🫖', 'Single-origin filter coffee', 'قهوة فلتر من مصدر واحد'],
        ['Iced Pistachio Latte', 'لاتيه فستق مثلج', 24, '🧊', 'Pistachio cream, cold espresso', 'كريمة فستق وإسبريسو بارد', { groups: [drinkSize] }],
      ])),
      sec('bites', 'Bites', 'معجنات', it('btb', [
        ['Almond Croissant', 'كرواسون لوز', 14, '🥐', 'Twice-baked, frangipane', 'مخبوز مرتين بحشوة اللوز'],
        ['Cardamom Bun', 'كعكة الهيل', 12, '🥯', 'Soft, sticky, spiced', 'طرية ومتبلة'],
      ])),
    ],
  },
  {
    id: 'dawn', name: { en: 'Dawn Bakery & Manakish', ar: 'مخبز الفجر والمناقيش' }, tagline: { en: 'Oven-fresh, all morning', ar: 'طازج من الفرن' },
    categoryId: 'bakery', cuisine: { en: 'Manakish · Bakery', ar: 'مناقيش · مخبوزات' }, emoji: '🥙', colors: ['#FFE7B3', '#E0A93B'],
    rating: 4.6, ratingCount: 2005, etaMin: 15, etaMax: 25, deliveryFee: 3, minOrder: 12, hours: [5, 15], area: { en: 'Al Gharrafa', ar: 'الغرافة' },
    menu: [
      sec('man', 'Manakish', 'مناقيش', it('dw', [
        ['Zaatar Manousheh', 'منقوشة زعتر', 6, '🫓', 'Thyme, sesame, olive oil', 'زعتر وسمسم وزيت زيتون', { popular: true }],
        ['Cheese Manousheh', 'منقوشة جبنة', 9, '🧀', 'Akkawi and mozzarella', 'جبنة عكاوي وموزاريلا', { popular: true }],
        ['Lahm Bi Ajeen', 'لحم بعجين', 12, '🥙', 'Minced lamb, tomato, pomegranate', 'لحم مفروم وطماطم ورمان'],
        ['Breakfast Foul Plate', 'طبق فول', 14, '🍲', 'Foul, hummus, vegetables, bread', 'فول وحمص وخضار وخبز'],
      ])),
    ],
  },
  {
    id: 'freshmart', name: { en: 'FreshMart Express', ar: 'فريش مارت إكسبرس' }, tagline: { en: 'Groceries in under 30 minutes', ar: 'بقالة خلال أقل من 30 دقيقة' },
    categoryId: 'grocery', cuisine: { en: 'Supermarket', ar: 'سوبرماركت' }, emoji: '🛒', colors: ['#D4F0C0', '#6AB04C'],
    rating: 4.6, ratingCount: 6820, etaMin: 20, etaMax: 30, deliveryFee: 5, minOrder: 30, hours: [7, 1], area: { en: 'West Bay', ar: 'الخليج الغربي' },
    promo: { en: 'Free delivery over QAR 100', ar: 'توصيل مجاني فوق 100 ر.ق' },
    menu: [
      sec('fresh', 'Fruit & Veg', 'فواكه وخضار', it('fm', [
        ['Bananas (1 kg)', 'موز (1 كغ)', 6, '🍌', 'Ripe and sweet', 'ناضج وحلو', { popular: true }],
        ['Local Tomatoes (1 kg)', 'طماطم محلية (1 كغ)', 5, '🍅', 'Grown in Qatar', 'إنتاج قطري'],
        ['Avocados (3 pcs)', 'أفوكادو (3 حبات)', 12, '🥑', 'Ready to eat', 'جاهز للأكل'],
        ['Medjool Dates (500 g)', 'تمر مجدول (500 غ)', 28, '🌴', 'Soft and caramel-like', 'طري بطعم الكراميل', { popular: true }],
      ])),
      sec('daily', 'Dairy & Pantry', 'ألبان ومؤن', it('fmd', [
        ['Fresh Milk (2 L)', 'حليب طازج (2 لتر)', 9, '🥛', 'Baladna full cream', 'كامل الدسم'],
        ['Eggs (30 pcs)', 'بيض (30 حبة)', 17, '🥚', 'Large, farm fresh', 'كبير وطازج'],
        ['Basmati Rice (5 kg)', 'أرز بسمتي (5 كغ)', 32, '🍚', 'Extra-long grain', 'حبة طويلة'],
        ['Arabic Bread (6 pcs)', 'خبز عربي (6 حبات)', 4, '🫓', 'Baked this morning', 'مخبوز صباحاً'],
        ['Water 330ml (24 pack)', 'مياه 330 مل (24)', 10, '💧', 'Natural mineral water', 'مياه معدنية طبيعية'],
      ])),
    ],
  },
  {
    id: 'careplus', name: { en: 'Care Plus Pharmacy', ar: 'صيدلية كير بلس' }, tagline: { en: 'Health & beauty, 24/7', ar: 'صحة وجمال على مدار الساعة' },
    categoryId: 'pharmacy', cuisine: { en: 'Pharmacy · Beauty', ar: 'صيدلية · جمال' }, emoji: '💊', colors: ['#CFF3EF', '#2BB5A6'],
    rating: 4.7, ratingCount: 1330, etaMin: 20, etaMax: 35, deliveryFee: 6, minOrder: 20, hours: [0, 24], area: { en: 'Al Sadd', ar: 'السد' },
    menu: [
      sec('health', 'Health', 'صحة', it('cp', [
        ['Paracetamol 500mg (24)', 'باراسيتامول 500 ملغ (24)', 7, '💊', 'Pain & fever relief', 'مسكن وخافض حرارة', { popular: true }],
        ['Vitamin C 1000mg (30)', 'فيتامين سي 1000 ملغ (30)', 32, '🍊', 'Daily immune support', 'دعم يومي للمناعة'],
        ['Hand Sanitiser 250ml', 'معقم أيدي 250 مل', 12, '🧴', '70% alcohol', 'كحول 70٪'],
        ['Sunscreen SPF 50', 'واقي شمس 50', 58, '☀️', 'Water resistant, 100ml', 'مقاوم للماء 100 مل'],
      ])),
      sec('baby', 'Baby & Care', 'الأم والطفل', it('cpb', [
        ['Baby Wipes (3 packs)', 'مناديل أطفال (3 عبوات)', 22, '👶', 'Gentle & fragrance-free', 'لطيفة وبدون عطر'],
        ['Nappies Size 4 (44)', 'حفاضات مقاس 4 (44)', 54, '🍼', 'Overnight protection', 'حماية طوال الليل'],
      ])),
    ],
  },
  {
    id: 'bloom', name: { en: 'Bloom & Co.', ar: 'بلوم آند كو' }, tagline: { en: 'Fresh flowers & thoughtful gifts', ar: 'ورد طازج وهدايا مميزة' },
    categoryId: 'flowers', cuisine: { en: 'Florist · Gifts', ar: 'ورود · هدايا' }, emoji: '💐', colors: ['#F5D5F2', '#B661C9'],
    rating: 4.9, ratingCount: 740, etaMin: 40, etaMax: 60, deliveryFee: 10, minOrder: 60, hours: [9, 22], area: { en: 'The Pearl-Qatar', ar: 'اللؤلؤة قطر' },
    menu: [
      sec('bouquets', 'Bouquets', 'باقات', it('bl', [
        ['Pink Peonies Bouquet', 'باقة الفاوانيا الوردية', 180, '🌸', 'Seasonal peonies wrapped by hand', 'فاوانيا موسمية بتغليف يدوي', { popular: true }],
        ['Red Roses (12)', 'ورد أحمر (12)', 140, '🌹', 'Long-stem, with greenery', 'ساق طويل مع خضرة', { popular: true }],
        ['Orchid Pot', 'أصيص أوركيد', 120, '🪻', 'Long-lasting white orchid', 'أوركيد أبيض يدوم طويلاً'],
        ['Chocolate & Rose Box', 'علبة شوكولاتة وورد', 160, '🍫', 'Belgian chocolates, preserved roses', 'شوكولاتة بلجيكية وورد محفوظ'],
      ])),
    ],
  },
];

export const vendorById = (id: string) => vendors.find((v) => v.id === id);

/** Is the store open at `date`? Handles closing past midnight and 24h stores. */
export function isOpen(v: Vendor, date = new Date()) {
  const [from, to] = v.hours;
  const h = date.getHours() + date.getMinutes() / 60;
  if (from === 0 && to === 24) return true;
  if (to > from) return h >= from && h < to;
  return h >= from || h < (to % 24);
}

export const fmtHour = (h: number, lang: 'en' | 'ar') => {
  const hh = h % 24;
  const ampm = hh >= 12 ? (lang === 'ar' ? 'م' : 'PM') : lang === 'ar' ? 'ص' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:00 ${ampm}`;
};
