---
layout: post.njk
title: "Introduction à Go"
description: "Les bases du langage : types, variables, fonctions, structs, interfaces, gestion d'erreurs et goroutines."
date: 2026-07-07
tags: [go, golang, programmation]
---

## Introduction à Go

Go est un langage compilé, statiquement typé, conçu par Google pour être simple et rapide. Pas de classes, pas d'héritage, pas d'exceptions.
Un programme Go minimal :

```go
package main

import "fmt"

func main() {
    fmt.Println("Hello, world")
}
```

## Types numériques

| Type | Taille | Usage |
|------|--------|-------|
| `int` | 32 ou 64 bits selon la plateforme | Entier générique |
| `int8` / `int16` / `int32` / `int64` | Fixe | Quand la taille compte |
| `uint` / `uint8`... | Non signé | Toujours positif |
| `float32` | 32 bits | Précision simple |
| `float64` | 64 bits | Précision double |

## Texte

```go
var s string = "une chaîne"   // string = séquence d'octets UTF-8
var r rune   = 'A'            // rune = alias de int32, un caractère Unicode

fmt.Printf("%.3f %s\n", 3.14159, s)   // %.3f = float à 3 décimales
```

`string` et `rune` sont deux choses différentes dans Go. Un string est une suite d'octets, une rune est un point de code Unicode (un caractère en gros).

## Variables

```go
// Déclaration explicite
var x int = 10

// Inférence de type. Uniquement à l'intérieur d'une fonction
y := 21

// Constante
const Pi = 3.14159 // Très original
```

`:=` crée et affecte en même temps. 
`=` modifie une variable existante.

En dehors d'une fonction, il faut obligatoirement utiliser `var`.

## Boucles

Go n'a qu'un mot-clé de boucle : `for`.

`while`? Y'A PAS.

```go
// Boucle classique
for i := 0; i < 10; i++ {
    fmt.Println(i)
}

// "Équivalent" de while
n := 0
for n < 10 {

    fmt.Println(n)


    n++
}

// Boucle infinie, break pour sortir
for {
    ...
}

// Itérer sur une slice ou une map
nombres := []int{1, 2, 3}

for index, valeur := range nombres {
    fmt.Println(index, valeur)
}
```

## Slices et Maps

```go
// Slice (tableau dynamique)
s := []string{"go", "est", "rigolo"}
s = append(s, ". Genre, vraiment.")

// Map (dictionnaire)
ages := map[string]int{
    "dani": 26,
    "alice": 30,
    "la folle du bus": 40,
}
ages["JohnPersona"] = 6

valeur, existe := ages["JohnPersona"]   // vérifier si une clé existe
```

## Fonctions

```go
// Fonction simple
func add(a int, b int) int {
    return a + b
}

// Retour multiple, idiome Go pour les erreurs
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("division par zéro")
    }

    return a / b, nil // nil indique qu'il n'y a pas d'erreurs
}
```

Go permet de retourner plusieurs valeurs. C'est la base de la gestion d'erreurs.

## Structs

Go n'a pas de classes. Les données sont regroupées dans des structs (Comme en C).

```go
type User struct {
    Name  string
    Email string
    Age   int
}

// Méthode attachée à la struct
func (u User) String() string {
    return fmt.Sprintf("%s <%s>", u.Name, u.Email)
}

u := User{Name: "Dani", Email: "dani@example.com", Age: 26}
fmt.Println(u.String())
```

## Interfaces

Une interface définit un comportement. N'importe quel type qui implémente les méthodes satisfait l'interface, sans le déclarer explicitement.

```go
type Animal interface {
    Sound() string
}

type Dog struct{}
type Cat struct{}

func (d Dog) Sound() string { return "woof" }
func (c Cat) Sound() string { return "meow" }

func describe(a Animal) {
    fmt.Println(a.Sound())
}

describe(Dog{})   // woof
describe(Cat{})   // meow
```

## Gestion d'erreurs

Pas d'exceptions en Go. Les erreurs sont des valeurs retournées et vérifiées explicitement.

```go
result, err := divide(10, 0)
if err != nil {
    fmt.Println("erreur :", err)
    return
}
fmt.Println(result)
```

Le pattern `if err != nil` revient partout. C'est verbeux mais explicite ON sais comme ça exactement où ça peut échouer.

## Goroutines et channels

Go a la concurrence dans son ADN. Une **goroutine** (vrai nom) est une fonction qui tourne en parallèle, lancée avec `go`.

```go
func worker(id int) {
    fmt.Printf("worker %d terminé\n", id)
}

go worker(1)   // lancé en arrière-plan
go worker(2)

// Les channels permettent aux goroutines de communiquer
ch := make(chan int)

go func() {
    ch <- 42   // envoyer
}()

valeur := <-ch   // recevoir (bloquant jusqu'à réception)
fmt.Println(valeur)
```

## Commentaires

Par convention, chaque commentaire commence par le nom exact de la fonction ou variable commentée (sensible à la casse) et se termine par un point.

```go
// Add returns the sum of a and b.
func Add(a, b int) int {
    return a + b
}
```

C'est la convention utilisée par `godoc` pour générer la documentation automatiquement.

*Un jour je ferais un opérateur pour K8s avec ça...*