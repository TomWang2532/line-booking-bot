require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors'); // 之後前端 LIFF 會用到，先裝起來

// 1. 設定
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const app = express();

// 允許 JSON 格式的請求 (為了讓 LIFF 可以傳資料過來)
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// --- LINE Webhook (保留原本的聊天功能) ---
app.post('/callback', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// --- 新增：API 區域 (給 LIFF 網頁用的) ---

// API 1: 查詢某日期的可預約時段
// 用法: GET /api/slots?date=2025-12-20
app.get('/api/slots', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Missing date parameter' });

  // 1. 定義全天時段 (08:00 - 22:00)
  const allSlots = [];
  for (let i = 8; i <= 21; i++) {
    const hour = i.toString().padStart(2, '0');
    allSlots.push(`${hour}:00`);
  }

  try {
    // 2. 去資料庫查那天已經被訂走的時段
    const { data: booked, error } = await supabase
      .from('appointments')
      .select('start_time')
      .eq('booking_date', date)
      .in('status', ['pending', 'confirmed']); // 只看待審核和已確認的

    if (error) throw error;

    // 3. 過濾出剩下的空位
    const bookedTimes = booked.map(b => b.start_time.slice(0, 5)); // 取 "14:00" 格式
    const availableSlots = allSlots.map(time => ({
      time,
      isBooked: bookedTimes.includes(time)
    }));

    res.json({ date, slots: availableSlots });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// API 2: 送出預約請求
// 用法: POST /api/bookings
// API 2: 送出預約請求 (防黃牛加強版)
app.post('/api/bookings', async (req, res) => {
  const { userId, date, time } = req.body; 

  if (!userId || !date || !time) {
    return res.status(400).json({ error: '資料不完整' });
  }

  try {
    // 1. 換取 User ID
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('line_user_id', userId)
      .single();
    
    if (!user) return res.status(404).json({ error: '找不到此用戶' });

    // ==========================================
    // 🛑 防黃牛邏輯開始
    // ==========================================

    // 規則 A: 檢查該時段是否已被別人訂走
    const { data: slotTaken } = await supabase
      .from('appointments')
      .select('id')
      .eq('booking_date', date)
      .eq('start_time', time)
      .in('status', ['pending', 'confirmed']) // 只要有人卡位就不行
      .maybeSingle();

    if (slotTaken) {
      return res.status(409).json({ error: '慢了一步！該時段剛被搶走' });
    }

    // 規則 B: 檢查這個人當天是否已經有預約了？ (每日限購一單)
    const { data: myBookings } = await supabase
      .from('appointments')
      .select('id')
      .eq('user_id', user.id)
      .eq('booking_date', date)
      .in('status', ['pending', 'confirmed']) // 不包含已取消的
      // .maybeSingle();

    // 修正重點：只要找到任何一筆 (length > 0)，就直接擋
    if (myBookings && myBookings.length > 0) {
      return res.status(400).json({ error: '您當天已有預約，請勿重複佔位' });
    }

    // ==========================================
    // 🛑 防黃牛邏輯結束，放行！
    // ==========================================

    // 3. 寫入預約單
    const { error } = await supabase
      .from('appointments')
      .insert([
        { 
          user_id: user.id,
          booking_date: date,
          start_time: time,
          end_time: `${parseInt(time) + 1}:00`,
          status: 'pending' 
        }
      ]);

    if (error) throw error;

    res.json({ success: true, message: '預約申請已送出' });

  } catch (err) {
    console.error('預約失敗:', err);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});
// --- 事件處理 (跟原本一樣) ---
const client = new line.Client(lineConfig);
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);
  
  // 自動註冊邏輯 (省略重複代碼，保留你原本寫的即可)
  // ...
  
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `收到：${event.message.text}`
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});