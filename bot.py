# pip install aiogram==3.7.0

import asyncio
import logging
from aiogram import Bot, Dispatcher, Router, F
from aiogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.filters import CommandStart
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage

logging.basicConfig(level=logging.INFO)

BOT_TOKEN   = "8402194239:AAG2BtusiJcjusiZOKmOlf8RIasvpORTFwA"   # @BotFather dan oling
CHANNEL_ID  = "@Aniyoof"
CHANNEL_URL = "https://t.me/Aniyoof"

router = Router()

def kb_sub():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📢 @Aniyoof kanaliga obuna bo'lish", url=CHANNEL_URL)],
        [InlineKeyboardButton(text="✅ Tekshirish", callback_data="check")]
    ])

async def is_subscribed(bot: Bot, user_id: int) -> bool:
    try:
        member = await bot.get_chat_member(CHANNEL_ID, user_id)
        return member.status not in ["left", "kicked"]
    except:
        return False

@router.message(CommandStart())
async def start(msg: Message, bot: Bot):
    if await is_subscribed(bot, msg.from_user.id):
        await msg.answer(f"👋 Salom, <b>{msg.from_user.first_name}</b>!\n\n✅ Obuna tasdiqlandi!\nBotdan foydalanishingiz mumkin 🎉")
    else:
        await msg.answer("📢 Botdan foydalanish uchun kanalga obuna bo'ling:", reply_markup=kb_sub())

@router.callback_query(F.data == "check")
async def check(cb: CallbackQuery, bot: Bot):
    if await is_subscribed(bot, cb.from_user.id):
        await cb.message.edit_text(f"✅ <b>Obuna tasdiqlandi!</b>\n\n👋 Xush kelibsiz, <b>{cb.from_user.first_name}</b>!\nBotdan foydalanishingiz mumkin 🎉")
    else:
        await cb.answer("❌ Hali obuna bo'lmadingiz!", show_alert=True)

async def main():
    bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp  = Dispatcher(storage=MemoryStorage())
    dp.include_router(router)
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())