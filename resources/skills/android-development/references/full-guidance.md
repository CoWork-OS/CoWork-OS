# Android Development

You are an Android development specialist. Use the `run_command` tool to execute Gradle/ADB commands and file tools to create/edit Kotlin code.

## Jetpack Compose Patterns

### Screen with ViewModel
```kotlin
@Composable
fun ItemListScreen(
    viewModel: ItemViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    
    Scaffold(
        topBar = { TopAppBar(title = { Text("Items") }) },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.addItem() }) {
                Icon(Icons.Default.Add, contentDescription = "Add")
            }
        }
    ) { padding ->
        when (val state = uiState) {
            is UiState.Loading -> CircularProgressIndicator(modifier = Modifier.padding(padding))
            is UiState.Success -> {
                LazyColumn(contentPadding = padding) {
                    items(state.items, key = { it.id }) { item ->
                        ItemCard(item = item, onClick = { viewModel.selectItem(it) })
                    }
                }
            }
            is UiState.Error -> Text(state.message, modifier = Modifier.padding(padding))
        }
    }
}
```

### ViewModel with StateFlow
```kotlin
@HiltViewModel
class ItemViewModel @Inject constructor(
    private val repository: ItemRepository
) : ViewModel() {
    
    private val _uiState = MutableStateFlow<UiState<List<Item>>>(UiState.Loading)
    val uiState: StateFlow<UiState<List<Item>>> = _uiState.asStateFlow()
    
    init {
        viewModelScope.launch {
            repository.getItems()
                .catch { _uiState.value = UiState.Error(it.message ?: "Unknown error") }
                .collect { _uiState.value = UiState.Success(it) }
        }
    }
}

sealed interface UiState<out T> {
    data object Loading : UiState<Nothing>
    data class Success<T>(val data: T) : UiState<T>
    data class Error(val message: String) : UiState<Nothing>
}
```

## Data Layer

### Room Database
```kotlin
@Entity(tableName = "items")
data class ItemEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val description: String?,
    val createdAt: Long = System.currentTimeMillis()
)

@Dao
interface ItemDao {
    @Query("SELECT * FROM items ORDER BY createdAt DESC")
    fun getAll(): Flow<List<ItemEntity>>
    
    @Query("SELECT * FROM items WHERE id = :id")
    suspend fun getById(id: Long): ItemEntity?
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(item: ItemEntity): Long
    
    @Delete
    suspend fun delete(item: ItemEntity)
}

@Database(entities = [ItemEntity::class], version = 1)
abstract class AppDatabase : RoomDatabase() {
    abstract fun itemDao(): ItemDao
}
```

### Retrofit API
```kotlin
interface ApiService {
    @GET("items")
    suspend fun getItems(): List<ItemDto>
    
    @POST("items")
    suspend fun createItem(@Body item: CreateItemRequest): ItemDto
    
    @GET("items/{id}")
    suspend fun getItem(@Path("id") id: Long): ItemDto
}

// Hilt module:
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    @Provides
    @Singleton
    fun provideRetrofit(): Retrofit = Retrofit.Builder()
        .baseUrl("https://api.example.com/")
        .addConverterFactory(GsonConverterFactory.create())
        .build()
    
    @Provides
    @Singleton
    fun provideApiService(retrofit: Retrofit): ApiService =
        retrofit.create(ApiService::class.java)
}
```

### Repository Pattern
```kotlin
class ItemRepository @Inject constructor(
    private val api: ApiService,
    private val dao: ItemDao
) {
    fun getItems(): Flow<List<Item>> = dao.getAll().map { entities ->
        entities.map { it.toDomain() }
    }
    
    suspend fun refresh() {
        val remote = api.getItems()
        dao.insertAll(remote.map { it.toEntity() })
    }
}
```

## Dependency Injection (Hilt)
```kotlin
@HiltAndroidApp
class MyApp : Application()

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MyAppTheme { ItemListScreen() }
        }
    }
}
```

## Navigation (Compose)
```kotlin
@Composable
fun AppNavigation() {
    val navController = rememberNavController()
    NavHost(navController, startDestination = "items") {
        composable("items") {
            ItemListScreen(onItemClick = { navController.navigate("items/${it.id}") })
        }
        composable("items/{id}", arguments = listOf(navArgument("id") { type = NavType.LongType })) {
            ItemDetailScreen(itemId = it.arguments?.getLong("id") ?: 0)
        }
    }
}
```

## Firebase Integration
```kotlin
// FCM Token
FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
    // Send to server
}

// Crashlytics
FirebaseCrashlytics.getInstance().apply {
    setUserId(userId)
    setCustomKey("screen", screenName)
    recordException(exception)
}
```

## Gradle Commands

```bash
./gradlew assembleDebug                  # Build debug APK
./gradlew assembleRelease                # Build release APK
./gradlew bundleRelease                  # Build release AAB (for Play Store)
./gradlew connectedAndroidTest           # Run instrumented tests
./gradlew test                           # Run unit tests
./gradlew lint                           # Run lint checks
./gradlew dependencies                   # Show dependency tree
./gradlew clean                          # Clean build cache
./gradlew app:dependencies --configuration releaseRuntimeClasspath  # Release deps
```

## Emulator & ADB

```bash
emulator -list-avds                       # List available emulators
emulator @Pixel_7_API_34                  # Start emulator
adb devices                               # List connected devices
adb install app-debug.apk                 # Install APK
adb uninstall com.example.app             # Uninstall app
adb logcat *:E                            # Error logs only
adb logcat -s MyApp                       # Filter by tag
adb shell am start -n com.example.app/.MainActivity  # Launch activity
adb shell pm clear com.example.app        # Clear app data
adb reverse tcp:8080 tcp:8080             # Port forwarding
adb pull /sdcard/screenshot.png ./        # Pull file from device
```

## ProGuard / R8 (Release)
```proguard
# Keep data classes for Gson
-keep class com.example.app.data.model.** { *; }

# Keep Retrofit interfaces
-keep,allowobfuscation interface com.example.app.data.api.** { *; }

# Firebase
-keep class com.google.firebase.** { *; }
```

## Play Store Submission
1. Generate signed AAB: `./gradlew bundleRelease`
2. Upload to Play Console (internal -> closed -> open -> production track)
3. Fill store listing (screenshots, description, categorization)
4. Content rating questionnaire
5. Pricing and distribution settings
6. Submit for review

## Best Practices
- Use Jetpack Compose for all new UI code
- Follow single-activity architecture with Compose Navigation
- Use Hilt for dependency injection
- Prefer Flow over LiveData for reactive streams
- Use Kotlin Coroutines for async work
- Target the latest compileSdk, set appropriate minSdk
- Use App Bundle (.aab) instead of APK for Play Store
- Enable R8/ProGuard for release builds
- Test on multiple API levels and screen sizes
