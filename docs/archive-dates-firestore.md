# Modification des dates d'archives

Le site et l'espace professeur utilisent le même projet Firebase : `universit-4b11e`.
La correction des dates conserve l'identifiant de l'archive, ses stagiaires, ses examens et sa date de création.
Le bouton est disponible uniquement avec `users/{email}.admin == true` ; ce droit est relu lors de l'enregistrement.

## Protection à publier dans Firestore

Dans les règles existantes, remplacer uniquement le bloc `match /stageArchives/{docId}` par celui-ci.
Conserver toutes les autres règles et les fonctions `isProf()`, `isStage()` et `isAdmin()` déjà définies.

```javascript
match /stageArchives/{docId} {
  allow read: if isProf() || isStage() || isAdmin();
  allow create: if isProf() || isAdmin();
  allow delete: if isAdmin();
  allow update: if isAdmin()
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly([
      "title", "startDate", "endDate", "startDisplay", "endDisplay",
      "datesUpdatedAt", "datesUpdatedBy"
    ]);
}
```

Le fichier complet maintenu dans le dépôt Espace Prof (`firestore.rules`) contient également ce bloc.
Une publication du site sur Vercel ne publie pas les règles Firebase.
La suppression est réservée à l'administrateur pour empêcher le remplacement d'une archive par suppression puis recréation. La création habituelle d'archives par les professeurs reste autorisée.

## Vérification

- Admin : Archives → Modifier les dates → Enregistrer ; rouvrir après actualisation.
- Prof et stage : aucun bouton de modification. Une mise à jour directe des dates doit être refusée par Firestore.
- Vérifier que les stagiaires, les notes et l'identifiant de l'archive sont conservés.
- L'historique contient l'ancienne période, la nouvelle période et l'administrateur.

Tests locaux : `node --test tests/*.test.mjs`.
