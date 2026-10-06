import type { Category, Promo } from './types';

export const categories: Category[] = [
  { id: 'qatari', name: { en: 'Qatari', ar: 'قطري' }, emoji: '🍛', colors: ['#F6C177', '#E08A3C'], kind: 'food' },
  { id: 'shawarma', name: { en: 'Shawarma', ar: 'شاورما' }, emoji: '🌯', colors: ['#FFD28A', '#F29B38'], kind: 'food' },
  { id: 'burgers', name: { en: 'Burgers', ar: 'برغر' }, emoji: '🍔', colors: ['#FFB199', '#F0634B'], kind: 'food' },
  { id: 'pizza', name: { en: 'Pizza', ar: 'بيتزا' }, emoji: '🍕', colors: ['#FFC4C4', '#E5484D'], kind: 'food' },
  { id: 'asian', name: { en: 'Asian', ar: 'آسيوي' }, emoji: '🍣', colors: ['#C9E4FF', '#5B9BE6'], kind: 'food' },
  { id: 'indian', name: { en: 'Indian', ar: 'هندي' }, emoji: '🍲', colors: ['#FFD9A8', '#D9822B'], kind: 'food' },
  { id: 'healthy', name: { en: 'Healthy', ar: 'صحي' }, emoji: '🥗', colors: ['#C8F0D2', '#3DB86B'], kind: 'food' },
  { id: 'coffee', name: { en: 'Coffee & Karak', ar: 'قهوة وكرك' }, emoji: '☕', colors: ['#E7D2BE', '#A47551'], kind: 'food' },
  { id: 'desserts', name: { en: 'Desserts', ar: 'حلويات' }, emoji: '🧁', colors: ['#FFD3EA', '#E667A8'], kind: 'food' },
  { id: 'bakery', name: { en: 'Bakery', ar: 'مخابز' }, emoji: '🥐', colors: ['#FFE7B3', '#E0A93B'], kind: 'food' },
  { id: 'grocery', name: { en: 'Grocery', ar: 'بقالة' }, emoji: '🛒', colors: ['#D4F0C0', '#6AB04C'], kind: 'shop' },
  { id: 'pharmacy', name: { en: 'Pharmacy', ar: 'صيدلية' }, emoji: '💊', colors: ['#CFF3EF', '#2BB5A6'], kind: 'shop' },
  { id: 'flowers', name: { en: 'Flowers & Gifts', ar: 'ورود وهدايا' }, emoji: '💐', colors: ['#F5D5F2', '#B661C9'], kind: 'shop' },
];

export const promos: Promo[] = [
  {
    code: 'WELCOME30',
    title: { en: '30% off your first order', ar: 'خصم 30٪ على أول طلب' },
    desc: { en: 'Up to QAR 20 · Min. QAR 30', ar: 'حتى 20 ر.ق · الحد الأدنى 30 ر.ق' },
    colors: ['#FD8912', '#FD8912'], fg: '#201B17', emoji: '🎉', kind: 'percent', value: 30, cap: 20, minSubtotal: 30,
  },
  {
    code: 'FREEDEL',
    title: { en: 'Free delivery today', ar: 'توصيل مجاني اليوم' },
    desc: { en: 'On orders over QAR 25', ar: 'على الطلبات فوق 25 ر.ق' },
    colors: ['#276B54', '#276B54'], fg: '#FFFFFF', emoji: '🛵', kind: 'freeDelivery', value: 0, minSubtotal: 25,
  },
  {
    code: 'KASER20',
    title: { en: '20% off weekend feasts', ar: 'خصم 20٪ على وجبات العطلة' },
    desc: { en: 'Up to QAR 15 · Min. QAR 40', ar: 'حتى 15 ر.ق · الحد الأدنى 40 ر.ق' },
    colors: ['#201B17', '#201B17'], fg: '#FFF8EE', emoji: '🍽️', kind: 'percent', value: 20, cap: 15, minSubtotal: 40,
  },
  {
    code: 'QND18',
    title: { en: 'National Day: QAR 18 off', ar: 'اليوم الوطني: خصم 18 ر.ق' },
    desc: { en: 'Celebrate Qatar · Min. QAR 60', ar: 'احتفل مع قطر · الحد الأدنى 60 ر.ق' },
    colors: ['#FFE9CF', '#FFE9CF'], fg: '#201B17', emoji: '🇶🇦', kind: 'flat', value: 18, minSubtotal: 60,
  },
];

export const areas: { id: string; name: { en: string; ar: string } }[] = [
  { id: 'westbay', name: { en: 'West Bay', ar: 'الخليج الغربي' } },
  { id: 'pearl', name: { en: 'The Pearl-Qatar', ar: 'اللؤلؤة قطر' } },
  { id: 'lusail', name: { en: 'Lusail', ar: 'لوسيل' } },
  { id: 'sadd', name: { en: 'Al Sadd', ar: 'السد' } },
  { id: 'msheireb', name: { en: 'Msheireb', ar: 'مشيرب' } },
  { id: 'waab', name: { en: 'Al Waab', ar: 'الوعب' } },
  { id: 'aspire', name: { en: 'Aspire Zone', ar: 'أسباير' } },
  { id: 'wakra', name: { en: 'Al Wakrah', ar: 'الوكرة' } },
  { id: 'abuhamour', name: { en: 'Abu Hamour', ar: 'أبو هامور' } },
  { id: 'gharrafa', name: { en: 'Al Gharrafa', ar: 'الغرافة' } },
  { id: 'mansoura', name: { en: 'Al Mansoura', ar: 'المنصورة' } },
  { id: 'educity', name: { en: 'Education City', ar: 'المدينة التعليمية' } },
  { id: 'oldairport', name: { en: 'Old Airport', ar: 'المطار القديم' } },
  { id: 'umsalal', name: { en: 'Umm Salal', ar: 'أم صلال' } },
];

export const couriers = [
  { name: { en: 'Ahmed K.', ar: 'أحمد ك.' }, rating: 4.9, vehicle: { en: 'Motorbike', ar: 'دراجة نارية' }, plate: 'QA 48213' },
  { name: { en: 'Rashid M.', ar: 'راشد م.' }, rating: 4.8, vehicle: { en: 'Motorbike', ar: 'دراجة نارية' }, plate: 'QA 77120' },
  { name: { en: 'Faisal S.', ar: 'فيصل س.' }, rating: 4.9, vehicle: { en: 'Car', ar: 'سيارة' }, plate: 'QA 30951' },
  { name: { en: 'Sanjay P.', ar: 'سانجاي ب.' }, rating: 4.7, vehicle: { en: 'Motorbike', ar: 'دراجة نارية' }, plate: 'QA 62784' },
];

export const popularSearches = ['Machboos', 'Shawarma', 'Karak', 'Burger', 'Biryani', 'Sushi', 'Luqaimat', 'Pharmacy'];
