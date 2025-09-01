// server.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ===== Config MercadoPago SDK v2 =====
const { MercadoPagoConfig, PreApproval } = require("mercadopago");
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});
const preapproval = new PreApproval(mpClient);

// ===== Firebase Admin =====
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// =======================
// Stripe Checkout (pago único o subscripción Stripe)
// =======================
app.post("/stripe-checkout", async (req, res) => {
  try {
    const { priceId, email, uid } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      customer_email: email,
      success_url: "https://horas-planetarias.vercel.app/success",
      cancel_url: "https://horas-planetarias.vercel.app/cancel",
    });

    // Guardamos el id de la sesión en Firebase
    await db.collection("users").doc(uid).set(
      {
        stripeSessionId: session.id,
      },
      { merge: true }
    );

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Error Stripe Checkout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// MercadoPago Suscripción Mensual
// =======================
app.post("/mp-subscription", async (req, res) => {
  try {
    const { uid, email } = req.body;

    const response = await preapproval.create({
      body: {
        reason: "Suscripción Mensual - Plan Premium",
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: 300, // 💰 monto mensual
          currency_id: "UYU",
          start_date: new Date().toISOString(),
          end_date: new Date(
            new Date().setFullYear(new Date().getFullYear() + 1)
          ).toISOString(),
        },
        back_url: "https://horas-planetarias.vercel.app/success",
        payer_email: email,
      },
    });

    // Guardar en Firebase
    await db.collection("users").doc(uid).set(
      {
        mpPreapprovalId: response.id,
        subscriptionActive: false,
      },
      { merge: true }
    );

    res.json({ init_point: response.init_point });
  } catch (err) {
    console.error("Error MercadoPago Suscripción:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Estado de Suscripción
// =======================
app.get("/subscription-status/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      return res.json({ subscriptionActive: false });
    }

    const userData = userDoc.data();
    res.json({
      subscriptionActive: userData.subscriptionActive || false,
    });
  } catch (err) {
    console.error("Error Subscription Status:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// Start Server
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));