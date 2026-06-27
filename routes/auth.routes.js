import express from "express";
import {
  register,
  login,
  verifyEmail,
  resendVerificationEmail,
  forgotPassword,
  resetPassword,
  getCurrentUser,
  getDriverVerificationTimeline,
  changePassword,
  updateProfile,
  updateProfilePicture,
  removeProfilePicture,
  logout,
  completeProfile,
} from "../controllers/auth.controller.js";
import { authenticate, authEmailLimiter, authStrictLimiter } from "../middleware/auth.js";
import { runImageUpload } from "../middleware/upload.js";
import { asyncHandler } from "../utils/response.js";
import { validateRequest } from "../middleware/validation.js";
import {
  registerSchema,
  loginSchema,
  resetPasswordSchema,
  emailSchema,
  changePasswordSchema,
  updateProfileSchema,
  verifyEmailCodeSchema,
  verificationTimelineQuerySchema,
  completeProfileSchema,
} from "../validations/auth.validation.js";

const router = express.Router();

router.post("/register", authStrictLimiter, validateRequest(registerSchema), asyncHandler(register));
router.post("/login", authStrictLimiter, validateRequest(loginSchema), asyncHandler(login));
router.post("/signin", authStrictLimiter, validateRequest(loginSchema), asyncHandler(login));
router.post("/sign-in", authStrictLimiter, validateRequest(loginSchema), asyncHandler(login));
router.post("/verify-email", authStrictLimiter, validateRequest(verifyEmailCodeSchema), asyncHandler(verifyEmail));
router.post("/resend-verification", authEmailLimiter, validateRequest(emailSchema), asyncHandler(resendVerificationEmail));
router.post("/send-verification", authEmailLimiter, validateRequest(emailSchema), asyncHandler(resendVerificationEmail));
router.post("/forgot-password", authEmailLimiter, validateRequest(emailSchema), asyncHandler(forgotPassword));
router.post("/reset-password/:token", authEmailLimiter, validateRequest(resetPasswordSchema), asyncHandler(resetPassword));

router.get("/verify", asyncHandler(authenticate), asyncHandler(getCurrentUser));
router.get("/me", asyncHandler(authenticate), asyncHandler(getCurrentUser));
router.get("/verification-timeline", asyncHandler(authenticate), validateRequest(verificationTimelineQuerySchema), asyncHandler(getDriverVerificationTimeline));
router.patch("/profile", asyncHandler(authenticate), validateRequest(updateProfileSchema), asyncHandler(updateProfile));
router.patch("/complete-profile", asyncHandler(authenticate), validateRequest(completeProfileSchema), asyncHandler(completeProfile));
router.post("/profile-picture", asyncHandler(authenticate), runImageUpload, asyncHandler(updateProfilePicture));
router.delete("/profile-picture", asyncHandler(authenticate), asyncHandler(removeProfilePicture));
router.put("/change-password", asyncHandler(authenticate), validateRequest(changePasswordSchema), asyncHandler(changePassword));
router.post("/logout", asyncHandler(authenticate), asyncHandler(logout));

export default router;
