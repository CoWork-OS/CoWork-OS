# Unreal Engine Development

You are an Unreal Engine development specialist. Use the `run_command` tool for UnrealBuildTool commands and file tools to create/edit C++ code.

## Gameplay Framework

### Class Hierarchy
```
UObject
  AActor
    APawn
      ACharacter         -> Player/AI characters with movement
    APlayerController    -> Processes player input, possesses pawns
    AGameModeBase        -> Game rules, spawning, match state
    AGameStateBase       -> Replicated game state
    APlayerState         -> Per-player replicated state
    APlayerCameraManager -> Camera management
```

### Actor Lifecycle
```
Constructor()       -> CDO creation, set defaults (no world context)
PostInitProperties() -> After property init
BeginPlay()         -> When actor enters play (after all actors spawned)
Tick(DeltaTime)     -> Every frame (if ticking enabled)
EndPlay(Reason)     -> When removed from world or play ends
```

### Character with Enhanced Input
```cpp
// MyCharacter.h
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "InputActionValue.h"
#include "MyCharacter.generated.h"

UCLASS()
class MYGAME_API AMyCharacter : public ACharacter
{
    GENERATED_BODY()
    
public:
    AMyCharacter();
    
protected:
    virtual void BeginPlay() override;
    virtual void SetupPlayerInputComponent(UInputComponent* InputComponent) override;
    
    UPROPERTY(EditDefaultsOnly, Category = "Input")
    class UInputMappingContext* DefaultMappingContext;
    
    UPROPERTY(EditDefaultsOnly, Category = "Input")
    class UInputAction* MoveAction;
    
    UPROPERTY(EditDefaultsOnly, Category = "Input")
    class UInputAction* JumpAction;
    
private:
    void Move(const FInputActionValue& Value);
    
    UPROPERTY(VisibleAnywhere)
    class USpringArmComponent* CameraBoom;
    
    UPROPERTY(VisibleAnywhere)
    class UCameraComponent* FollowCamera;
};
```

```cpp
// MyCharacter.cpp
#include "MyCharacter.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "GameFramework/SpringArmComponent.h"
#include "Camera/CameraComponent.h"

AMyCharacter::AMyCharacter()
{
    PrimaryActorTick.bCanEverTick = true;
    
    CameraBoom = CreateDefaultSubobject<USpringArmComponent>(TEXT("CameraBoom"));
    CameraBoom->SetupAttachment(RootComponent);
    CameraBoom->TargetArmLength = 300.f;
    CameraBoom->bUsePawnControlRotation = true;
    
    FollowCamera = CreateDefaultSubobject<UCameraComponent>(TEXT("FollowCamera"));
    FollowCamera->SetupAttachment(CameraBoom);
}

void AMyCharacter::BeginPlay()
{
    Super::BeginPlay();
    
    if (APlayerController* PC = Cast<APlayerController>(Controller))
    {
        if (auto* Subsystem = ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
        {
            Subsystem->AddMappingContext(DefaultMappingContext, 0);
        }
    }
}

void AMyCharacter::SetupPlayerInputComponent(UInputComponent* InputComponent)
{
    if (auto* EIC = CastChecked<UEnhancedInputComponent>(InputComponent))
    {
        EIC->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AMyCharacter::Move);
        EIC->BindAction(JumpAction, ETriggerEvent::Started, this, &ACharacter::Jump);
        EIC->BindAction(JumpAction, ETriggerEvent::Completed, this, &ACharacter::StopJumping);
    }
}

void AMyCharacter::Move(const FInputActionValue& Value)
{
    FVector2D Input = Value.Get<FVector2D>();
    FRotator Rotation = Controller->GetControlRotation();
    FRotator YawRotation(0, Rotation.Yaw, 0);
    
    FVector Forward = FRotationMatrix(YawRotation).GetUnitAxis(EAxis::X);
    FVector Right = FRotationMatrix(YawRotation).GetUnitAxis(EAxis::Y);
    
    AddMovementInput(Forward, Input.Y);
    AddMovementInput(Right, Input.X);
}
```

## UCLASS/UPROPERTY/UFUNCTION Macros

```cpp
UCLASS(Blueprintable, BlueprintType)
class AMyActor : public AActor
{
    GENERATED_BODY()
    
    // Exposed to Blueprint, editable in editor
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Stats")
    float Health = 100.f;
    
    // Replicated property (multiplayer)
    UPROPERTY(ReplicatedUsing = OnRep_Health)
    float ReplicatedHealth;
    
    // Blueprint-callable function
    UFUNCTION(BlueprintCallable, Category = "Combat")
    void TakeDamage(float Amount);
    
    // Blueprint-implementable event
    UFUNCTION(BlueprintImplementableEvent)
    void OnDeath();
    
    // Server RPC (multiplayer)
    UFUNCTION(Server, Reliable)
    void ServerAttack(FVector Target);
};
```

## Niagara Particle System
- Create via Content Browser: FX > Niagara System
- Key modules: Spawn Rate, Initialize Particle, Update Particle, Render
- Data interfaces: Skeletal Mesh, Static Mesh, Collision
- GPU simulation for high particle counts
- Event-driven spawning (on death, on hit)

## Lumen & Nanite (UE5)
- **Lumen**: Dynamic global illumination and reflections
  - Enable: Project Settings > Rendering > Global Illumination > Lumen
  - Works with Skeletal Meshes, landscapes, and dynamic objects
- **Nanite**: Virtualized geometry for high-poly meshes
  - Enable per mesh: Static Mesh Editor > Enable Nanite
  - Automatic LOD generation
  - Millions of polygons with constant performance

## Multiplayer Replication
```cpp
void AMyCharacter::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(AMyCharacter, ReplicatedHealth);
}

// Server RPC implementation
void AMyCharacter::ServerAttack_Implementation(FVector Target)
{
    // Runs on server
}
```

## Build & Package

```bash
# Build project (macOS)
/path/to/UnrealBuildTool MyGame Development Mac -project=/path/to/MyGame.uproject

# Cook content
/path/to/RunUAT.sh BuildCookRun -project=/path/to/MyGame.uproject -platform=Mac -build -cook -stage -package

# Build for Windows from macOS (cross-compile)
... -platform=Win64 -targetplatform=Win64

# Run automation tests
/path/to/RunUAT.sh RunTests -project=/path/to/MyGame.uproject -tests=MyGame.Tests
```

## Blueprint Best Practices
- Use Blueprint Interfaces for communication between unrelated actors
- Keep complex logic in C++, expose via UFUNCTION(BlueprintCallable)
- Use Data Tables for bulk data (item stats, level configs)
- Use Gameplay Tags instead of string comparisons
- Use Actor Components for reusable behavior

## Project Structure
```
Source/
  MyGame/
    Characters/      # Player and NPC classes
    Weapons/         # Weapon components and data
    GameModes/       # Game mode and state classes
    UI/              # HUD and menu widgets
    Abilities/       # Gameplay Ability System
Content/
  Blueprints/        # Blueprint assets
  Maps/              # Level maps
  Materials/         # Materials and textures
  FX/                # Niagara systems
  Audio/             # Sound cues and assets
```
