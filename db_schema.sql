-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    line_user_id TEXT UNIQUE NOT NULL,
    name TEXT,
    phone TEXT,
    birthday DATE,
    referrer TEXT,
    tags TEXT[],
    blocked BOOLEAN DEFAULT FALSE,
    throttled BOOLEAN DEFAULT FALSE,
    group_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User Groups Table (Family Quota)
CREATE TABLE IF NOT EXISTS user_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add Foreign Key to users
ALTER TABLE users ADD CONSTRAINT fk_group FOREIGN KEY (group_id) REFERENCES user_groups(id);

-- Daily Slots Table (Inventory Core)
CREATE TABLE IF NOT EXISTS daily_slots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    date DATE NOT NULL,
    time TIME NOT NULL,
    is_open BOOLEAN DEFAULT TRUE,
    status TEXT DEFAULT 'available', -- available, locked, booked
    appointment_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(date, time)
);

-- Appointments Table
CREATE TABLE IF NOT EXISTS appointments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    booking_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, confirmed, rejected, cancelled
    type TEXT DEFAULT 'general', -- general, vip, manual
    admin_note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Link daily_slots to appointments
ALTER TABLE daily_slots ADD CONSTRAINT fk_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id);

-- Recurring Plans (VIP)
CREATE TABLE IF NOT EXISTS recurring_plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    day_of_week INTEGER NOT NULL, -- 0=Sunday, 1=Monday, ...
    time TIME NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- System Settings
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_users_line_id ON users(line_user_id);
CREATE INDEX idx_daily_slots_date ON daily_slots(date);
CREATE INDEX idx_appointments_user_date ON appointments(user_id, booking_date);
