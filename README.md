# Telegram Bot - Obuna Tekshiruvchi

**Uzbek tilida tavsif:**

Bu Telegram boti foydalanuvchilarni ma'lum kanalga obuna bo'lishga majbur qiladi. Bot faqat obunachilarga xizmat ko'rsatadi.

## 🎯 Bot Xususiyatlari

✅ **Obuna Tekshiruvi** - Foydalanuvchi kanalga obuna bo'lganmi yoki yo'qligini tekshiradi
✅ **Qayta Tekshirish** - "Tekshirish" tugmasini bosib obunani qayta tekshirish mumkin
✅ **Xush Kelibsiz Xabari** - Obunachilarga maxsus xabar yuboriladi
✅ **Inline Tugmalar** - Foydalanuvchiga qulay interfeys

## 📋 O'rnatish Qadamlari

### 1. Python o'rnatish
Botni ishlatish uchun Python 3.8+ kerak.

### 2. Kutubxonalar o'rnatish
```bash
pip install -r requirements.txt
```

Yoki bevosita:
```bash
pip install aiogram==3.7.0
```

### 3. BOT_TOKEN o'rnatish

**A) @BotFather orqali tokenni olish:**
1. Telegram-da @BotFather ga xabar yuboring
2. `/start` yozing
3. `/newbot` tanglang
4. Bot nomi va username kiriting
5. Olingan tokenni nusxalang

**B) bot.py faylida tokenni qo'ying:**
```python
BOT_TOKEN = "YOUR_BOT_TOKEN_HERE"
```

### 4. Kanal yaratish
1. Telegram-da yangi kanal yarating
2. Kanal username'ini botga qo'ying

**bot.py da:**
```python
CHANNEL_ID  = "@YOUR_CHANNEL_USERNAME"
CHANNEL_URL = "https://t.me/YOUR_CHANNEL_USERNAME"
```

### 5. Botni ishga tushirish
```bash
python bot.py
```

## 🔧 Konfiguratsiya

### Bot Token
```python
BOT_TOKEN = "8402194239:AAG2BtusiJcjusiZOKmOlf8RIasvpORTFwA"
```
**XAVF: Tokenni publicga qo'ymang!**

### Kanal ID
```python
CHANNEL_ID = "@Aniyoof"  # Kanal username
```

### Kanal URL
```python
CHANNEL_URL = "https://t.me/Aniyoof"
```

## 📝 Kod Tuzilishi

```
bot.py                    # Asosiy bot fayli
requirements.txt         # Kutubxonalar ro'yxati
README.md                # Tavsif
```

## 🚀 Bot Ishning Logikasi

1. **Foydalanuvchi `/start` buyrugini yuboradi**
   ↓
2. **Bot obunani tekshiradi**
   ↓
3. **Agar obuna bo'lsa:**
   - ✅ Xush kelibsiz xabari yuboriladi
   
   **Agar obuna bo'lmasa:**
   - 📢 Kanal havolasi bilan xabar yuboriladi
   - ✅ Tekshirish tugmasi paydo bo'ladi

4. **"Tekshirish" tugmasini bosgucha:**
   - Bot obunani qayta tekshiradi
   - Obuna bo'lgan bo'lsa xush kelibsiz xabari ko'rsatiladi
   - Bo'lmasa "Hali obuna bo'lmadingiz" xabari ko'rsatiladi

## 📲 Bot Komandalar

| Komanda | Tavsif |
|---------|--------|
| `/start` | Botni ishga tushirish va obunani tekshirish |

## 🎨 Xabarlar

**Obuna bo'lgan foydalanuvchiga:**
```
👋 Salom, [Foydalanuvchi Ismi]!

✅ Obuna tasdiqlandi!
Botdan foydalanishingiz mumkin 🎉
```

**Obuna bo'lmagan foydalanuvchiga:**
```
📢 Botdan foydalanish uchun kanalga obuna bo'ling:

[📢 @Aniyoof kanaliga obuna bo'lish] [button]
[✅ Tekshirish] [button]
```

## ⚠️ Xavfli Aylantirishlar

### Bot Token Xavfsizligi
- ❌ Token'ni kodga bevosita yozma
- ✅ `.env` fayldan o'qing

**`.env` fayli yarating:**
```
BOT_TOKEN=8402194239:AAG2BtusiJcjusiZOKmOlf8RIasvpORTFwA
CHANNEL_ID=@Aniyoof
```

**`bot.py` da:**
```python
from dotenv import load_dotenv
import os

load_dotenv()
BOT_TOKEN = os.getenv('BOT_TOKEN')
CHANNEL_ID = os.getenv('CHANNEL_ID')
```

## 🐛 Muammolar va Yechimlar

### Problem 1: "Bot javob bermaydi"
- ✅ Token to'g'ri kiritilganini tekshiring
- ✅ Internet ulanishini tekshiring
- ✅ Kanal private yoki public ekanini tekshiring

### Problem 2: "Obuna tekshiruvi ishlam aylanmasdi"
- ✅ Kanal username to'g'ri kiritilganini tekshiring
- ✅ Bot kanalga admin qilib tayinlanganini tekshiring
- ✅ Kanal private yoki public ekanini tekshiring

### Problem 3: "aiohttp xatosi"
```bash
pip install --upgrade aiohttp
```

## 📚 Foydalanilgan Kutubxonalar

- **aiogram** - Telegram Bot API uchun
- **aiohttp** - Async HTTP requestlar uchun
- **python-dotenv** - .env fayllarni o'qish uchun

## 🔗 Foydali Havolalar

- [Aiogram Dokumentatsiyasi](https://docs.aiogram.dev/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [@BotFather](https://t.me/botfather)
- [Telegram Developers](https://t.me/TelegramBots)

## 📞 Support

Muammolar bo'lsa:
1. Xatoni o'qib chiqing
2. Loglarni tekshiring
3. GitHub issues'da savol bering

## 📄 Litsenziya

MIT License

---

**Mualliflar:** Telegram Bot Loyihasi
**Tayyorlangan:** 2024
**Til:** Uzbek
