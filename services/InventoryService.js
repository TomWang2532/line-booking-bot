class InventoryService {
  constructor(supabaseClient) {
    this.supabase = supabaseClient;
  }

  /**
   * Get slots for a specific date
   * @param {string} date
   */
  async getSlots(date) {
    // Inventory Mode: Read from daily_slots
    const { data: slots, error } = await this.supabase
      .from('daily_slots')
      .select('start_time, status, is_open')
      .eq('date', date)
      .eq('is_open', true)
      .order('start_time');

    if (error) throw error;

    // Map to simple format
    return slots.map(slot => ({
      time: slot.start_time.slice(0, 5), // HH:MM
      isBooked: slot.status !== 'available',
      status: slot.status
    }));
  }

  /**
   * Attempt to book a slot.
   * This logic replaces the ad-hoc check in the original API.
   * @param {string} userId
   * @param {string} date
   * @param {string} time
   */
  async attemptBooking(userId, date, time) {
    // 1. Find the slot in daily_slots
    // We strictly check for 'available' status.
    // In a real DB, we might want "SELECT FOR UPDATE" or RLS policies,
    // but here we check status first.

    // Check if slot exists and is available
    const { data: slot, error: slotError } = await this.supabase
      .from('daily_slots')
      .select('id, status')
      .eq('date', date)
      .eq('start_time', time) // time should be HH:MM:00 or similar match
      .single();

    if (slotError) {
        // If row doesn't exist, it implies slot not generated or not open?
        // Spec says "System automatically generates...".
        // If not found, assume not available/open.
        throw new Error('Slot not found or not open for booking.');
    }

    if (slot.status !== 'available') {
        throw new Error('Slot is already booked or locked.');
    }

    // 2. Lock the slot
    // We optimistically update the slot status to 'locked'.
    // To prevent race condition: Update where id = slot.id AND status = 'available'
    // If Rows Affected = 0, then someone stole it.

    // Note: Supabase JS update doesn't always return row count directly in simple syntax?
    // Actually it does return 'data'.
    const { data: updated, error: updateError } = await this.supabase
        .from('daily_slots')
        .update({ status: 'locked' }) // Temporarily lock it
        .eq('id', slot.id)
        .eq('status', 'available') // Optimistic locking
        .select();

    if (updateError) throw updateError;

    if (!updated || updated.length === 0) {
        throw new Error('Slot was just taken by another user.');
    }

    // Return the slot ID so we can link it if needed
    return slot.id;
  }

  /**
   * Confirm booking (link appointment)
   * This updates the daily_slots with the appointment ID.
   */
  async confirmSlotBooking(slotId, appointmentId) {
      const { error } = await this.supabase
          .from('daily_slots')
          .update({ appointment_id: appointmentId, status: 'booked' }) // or keep 'locked' until confirmed?
          // Spec: "Locked -> Pending Order".
          // If Admin accepts -> Confirmed.
          // If Admin rejects -> Released.
          // Let's assume 'locked' means "Pending Review".
          .eq('id', slotId);

      if (error) throw error;
  }
}

module.exports = InventoryService;
