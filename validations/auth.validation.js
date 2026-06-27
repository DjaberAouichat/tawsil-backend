import { z } from "zod"

const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/

const dateStringSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Format de date invalide")

export const registerSchema = z.object({
  body: z
    .object({
      firstName: z
        .string({
          required_error: "Le prénom est obligatoire",
        })
        .min(2, "Le prénom doit contenir au moins 2 caractères")
        .max(50, "Le prénom ne peut pas dépasser 50 caractères")
        .regex(/^[a-zA-ZÀ-ÿ\s-']+$/, "Le prénom ne peut contenir que des lettres, espaces, tirets et apostrophes"),

      lastName: z
        .string({
          required_error: "Le nom est obligatoire",
        })
        .min(2, "Le nom doit contenir au moins 2 caractères")
        .max(50, "Le nom ne peut pas dépasser 50 caractères")
        .regex(/^[a-zA-ZÀ-ÿ\s-']+$/, "Le nom ne peut contenir que des lettres, espaces, tirets et apostrophes"),

      email: z
        .string({
          required_error: "L'email est obligatoire",
        })
        .email("Format d'email invalide")
        .toLowerCase()
        .max(255, "L'email ne peut pas dépasser 255 caractères"),

      password: z
        .string({
          required_error: "Le mot de passe est obligatoire",
        })
        .min(8, "Le mot de passe doit contenir au moins 8 caractères")
        .max(128, "Le mot de passe ne peut pas dépasser 128 caractères")
        .regex(
          PASSWORD_COMPLEXITY_REGEX,
          "Le mot de passe doit contenir au moins une minuscule, une majuscule, un chiffre et un caractère spécial",
        ),

      phone: z
        .string({
          required_error: "Le numéro de téléphone est obligatoire",
        })
        .regex(/^(?:\+213[5-7]\d{8}|0[5-7]\d{8})$/, "Format de numéro de téléphone algérien invalide"),

      role: z
        .enum(["client", "driver"], {
          required_error: "Le rôle est obligatoire",
          invalid_type_error: "Le rôle doit être 'client' ou 'driver'",
        })
        .default("client"),

   
      licenseNumber: z
        .string()
        .min(5, "Le numéro de permis doit contenir au moins 5 caractères")
        .max(20, "Le numéro de permis ne peut pas dépasser 20 caractères")
        .optional(),

      licenseExpiry: z
        .string()
        .refine((value) => !Number.isNaN(new Date(value).getTime()), "Format de date invalide")
        .refine((date) => new Date(date) > new Date(), "La date d'expiration du permis doit être dans le futur")
        .optional(),

      idCard: z
        .string()
        .min(5, "Le numéro de carte d'identité doit contenir au moins 5 caractères")
        .max(20, "Le numéro de carte d'identité ne peut pas dépasser 20 caractères")
        .optional(),

      vehicleType: z
        .enum(["standard", "comfort", "premium", "van"], {
          invalid_type_error: "Type de véhicule invalide",
        })
        .optional(),

      vehicleMake: z
        .string()
        .min(2, "La marque du véhicule doit contenir au moins 2 caractères")
        .max(50, "La marque du véhicule ne peut pas dépasser 50 caractères")
        .optional(),

      vehicleModel: z
        .string()
        .min(2, "Le modèle du véhicule doit contenir au moins 2 caractères")
        .max(50, "Le modèle du véhicule ne peut pas dépasser 50 caractères")
        .optional(),

      vehicleYear: z
        .number()
        .int("L'année doit être un nombre entier")
        .min(2000, "L'année du véhicule doit être supérieure à 2000")
        .max(new Date().getFullYear() + 1, "L'année du véhicule ne peut pas être dans le futur")
        .optional(),

      vehicleColor: z
        .string()
        .min(3, "La couleur du véhicule doit contenir au moins 3 caractères")
        .max(30, "La couleur du véhicule ne peut pas dépasser 30 caractères")
        .optional(),

      vehicleLicensePlate: z
        .string()
        .min(4, "Plaque d'immatriculation invalide")
        .max(20, "Plaque d'immatriculation invalide")
        .optional(),

      vehicleInsuranceNumber: z
        .string()
        .min(5, "Le numéro d'assurance doit contenir au moins 5 caractères")
        .max(50, "Le numéro d'assurance ne peut pas dépasser 50 caractères")
        .optional(),

      vehicleInsuranceExpiry: z
        .string()
        .refine((value) => !Number.isNaN(new Date(value).getTime()), "Format de date invalide")
        .refine((date) => new Date(date) > new Date(), "La date d'expiration de l'assurance doit être dans le futur")
        .optional(),

 
      termsAccepted: z
        .boolean({
          required_error: "Vous devez accepter les conditions d'utilisation",
        })
        .refine((val) => val === true, "Vous devez accepter les conditions d'utilisation"),

      privacyAccepted: z
        .boolean({
          required_error: "Vous devez accepter la politique de confidentialité",
        })
        .refine((val) => val === true, "Vous devez accepter la politique de confidentialité"),
    }),
})

export const loginSchema = z.object({
    body: z.object({
      identifier: z.string().trim().min(1).optional(),
      email: z.string().trim().optional(),
      phone: z.string().trim().optional(),

      password: z
        .string({
          required_error: "Le mot de passe est obligatoire",
        })
        .min(1, "Le mot de passe est obligatoire"),

      rememberMe: z.boolean().optional().default(false),
    }).refine(
      (data) => !!(data.identifier || data.email || data.phone),
      { message: "L'email ou le numéro de téléphone est obligatoire", path: ["identifier"] },
    ),
  })

  export const emailSchema = z.object({
    body: z.object({
      email: z
        .string({
          required_error: "L'email est obligatoire",
        })
        .email("Format d'email invalide")
        .toLowerCase(),
    }),
  })

  export const verifyEmailCodeSchema = z.object({
    body: z.object({
      email: z
        .string({
          required_error: "L'email est obligatoire",
        })
        .email("Format d'email invalide")
        .toLowerCase(),
      code: z
        .string({
          required_error: "Le code de verification est obligatoire",
        })
        .regex(/^\d{6}$/, "Le code de verification doit contenir 6 chiffres"),
    }),
  })



  export const resetPasswordSchema = z.object({
    body: z
      .object({
        password: z
          .string({
            required_error: "Le mot de passe est obligatoire",
          })
          .min(8, "Le mot de passe doit contenir au moins 8 caractères")
          .max(128, "Le mot de passe ne peut pas dépasser 128 caractères")
          .regex(
            PASSWORD_COMPLEXITY_REGEX,
            "Le mot de passe doit contenir au moins une minuscule, une majuscule, un chiffre et un caractère spécial",
          ),
  
        confirmPassword: z.string({
          required_error: "La confirmation du mot de passe est obligatoire",
        }),
      })
      .refine((data) => data.password === data.confirmPassword, {
        message: "Les mots de passe ne correspondent pas",
        path: ["confirmPassword"],
      }),
  
    params: z.object({
      token: z
        .string({
          required_error: "Le token est obligatoire",
        })
        .min(1, "Token invalide"),
    }),
  })

  export const changePasswordSchema = z.object({
    body: z
      .object({
        currentPassword: z
          .string({
            required_error: "Le mot de passe actuel est obligatoire",
          })
          .min(1, "Le mot de passe actuel est obligatoire"),
  
        newPassword: z
          .string({
            required_error: "Le nouveau mot de passe est obligatoire",
          })
          .min(8, "Le nouveau mot de passe doit contenir au moins 8 caractères")
          .max(128, "Le nouveau mot de passe ne peut pas dépasser 128 caractères")
          .regex(
            PASSWORD_COMPLEXITY_REGEX,
            "Le nouveau mot de passe doit contenir au moins une minuscule, une majuscule, un chiffre et un caractère spécial",
          ),
  
        confirmNewPassword: z.string({
          required_error: "La confirmation du nouveau mot de passe est obligatoire",
        }),
      })
      .refine((data) => data.newPassword === data.confirmNewPassword, {
        message: "Les nouveaux mots de passe ne correspondent pas",
        path: ["confirmNewPassword"],
      })
      .refine((data) => data.currentPassword !== data.newPassword, {
        message: "Le nouveau mot de passe doit être différent de l'ancien",
        path: ["newPassword"],
      }),
  })

  export const updateProfileSchema = z.object({
    body: z
      .object({
        phone: z
          .string()
          .regex(
            /^(?:\+213[5-7]\d{8}|0[5-7]\d{8})$/,
            "Format de numéro de téléphone algérien invalide",
          )
          .optional(),
        profilePicture: z.string().url("URL d'image invalide").optional(),
      })
      .refine((data) => Boolean(data.phone || data.profilePicture), {
        message: "Au moins un champ doit être fourni",
        path: ["phone"],
      }),
  })

export const completeProfileSchema = z.object({
  body: z.object({
    firstName: z.string().min(1).max(50).optional(),
    lastName: z.string().min(1).max(50).optional(),
    phone: z.string().regex(/^(?:\+213[5-7]\d{8}|0[5-7]\d{8})$/, "Format de numéro de téléphone algérien invalide").optional(),
    profilePicture: z.string().url().optional(),
    city: z.string().max(100).optional(),
    address: z.string().max(1000).optional(),
    accountType: z.enum(["client", "driver"]).optional(),

    // Driver specific
    licenseNumber: z.string().min(5).max(50).optional(),
    licenseExpiry: dateStringSchema.optional(),
    idCard: z.string().min(3).max(50).optional(),

    vehicleType: z.enum(["standard", "comfort", "premium", "van"]).optional(),
    vehicleMake: z.string().optional(),
    vehicleModel: z.string().optional(),
    vehicleYear: z.number().int().optional(),
    vehicleColor: z.string().optional(),
    vehicleLicensePlate: z.string().optional(),
    vehicleInsuranceNumber: z.string().optional(),
    vehicleInsuranceExpiry: dateStringSchema.optional(),

    vehicle: z
      .object({
        type: z.enum(["standard", "comfort", "premium", "van"]).optional(),
        make: z.string().optional(),
        model: z.string().optional(),
        year: z.number().int().optional(),
        color: z.string().optional(),
        licensePlate: z.string().optional(),
        insuranceNumber: z.string().optional(),
        insuranceExpiry: dateStringSchema.optional(),
      })
      .optional(),

    documents: z.array(z.object({ url: z.string().url(), type: z.string().optional(), expiryDate: dateStringSchema.optional() })).optional(),
  }),
})

export const verificationTimelineQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
})

