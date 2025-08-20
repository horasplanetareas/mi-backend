const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");

// === Stripe ===
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// === MercadoPago ===
const mercadopago = require("mercadopago");
mercadopago.configure({ access_token: process.env.MP_ACCESS_TOKEN });

// === Firebase ===
// 🔑 Opción 1: con archivo local (solo dev)
// admin.initializeApp({
//   credential: admin.credential.cert(require("./serviceAccount.json"))
// });

// 🔑 Opción 2: más seguro (usar en Railway)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// =======================
// Stripe: Crear checkout
// =======================
app.post("/create-checkout-stripe", async (req, res) => {
  try {
    const { priceId, email } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://tuapp.com/success",
      cancel_url: "https://tuapp.com/cancel",
      customer_email: email,
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("❌ Error Stripe:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// MercadoPago: Crear preferencia
// =======================
app.post("/create-preference-mp", async (req, res) => {
  try {
    let preference = {
      items: [
        {
          title: "Suscripción Mensual",
          unit_price: 300, // Precio en UYU
          quantity: 1,
        },
      ],
      back_urls: {
        success: "https://tuapp.com/success",
        failure: "https://tuapp.com/failure",
        pending: "https://tuapp.com/pending",
      },
      auto_return: "approved",
    };

    const response = await mercadopago.preferences.create(preference);
    res.json({ init_point: response.body.init_point });
  } catch (err) {
    console.error("❌ Error MP:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// TODO: Webhooks Stripe & MP
// =======================

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
